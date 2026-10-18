# Phase 5 - Rate limiting and tenant fairness

Status: the rate-limited 10k-request checkpoint passed on 2026-10-18 after publisher and worker changes. Sustained dispatch-pressure coverage remains pending. The original run on 2026-10-17 exceeded the 30-second quiet-tenant threshold.

## Independent budgets

Ingestion and delivery use separate Redis token buckets for each tenant:

- `waybill:rate-limit:ingestion:tenant:{tenantId}`
- `waybill:rate-limit:delivery:tenant:{tenantId}`

Both paths previously consumed the same bucket. An ingestion burst could exhaust the tokens required to dispatch accepted events. Different ingestion and delivery configurations also operated on the same stored state.

The shared limiter now requires a scope at each call site. Each bucket still uses the existing atomic Lua script for refill and consumption. The default capacity and refill rate are 10 tokens and 10 tokens per second for each scope. The four configuration variables are listed in `.env.example`.

Ingestion returns HTTP 429 with `Retry-After` when its bucket is exhausted. The worker defers rate-limited messages using `ChangeMessageVisibility` without incrementing the delivery attempt count.

Existing unscoped keys expire through their TTL. New scoped keys start with full capacity, so deploying this change resets the available burst budget once.

## Regression coverage

The limiter tests verify burst exhaustion, refill, and isolation between scopes and tenants. The isolation test uses an in-memory implementation of the Redis EVAL interface to check key routing. It does not verify Lua execution, concurrent Redis access, or SQS scheduling.

## Remaining checkpoint

The original request-burst scenario now passes with the same traffic parameters and latency threshold. Next, test a sustained backlog of accepted events to isolate dispatch fairness from ingestion rejection. The current result is limited to the measured local configuration and fast receiver.

The test must exercise the API, outbox poller, Redis, SQS, worker, and receiver. Token-bucket unit tests alone do not establish fairness across the full pipeline.

## Fairness runner

### Publisher changes

Pending outbox rows are ranked by `(created_at, id)` within each tenant. Selection takes each tenant's first pending row before taking second rows. A tenant cursor rotates the starting point between batches, including when more tenants are pending than the batch limit. Ranking happens before the global limit, so a quiet tenant is not excluded by a large older backlog.

The publisher sends at most ten messages concurrently and waits for every result before selecting the next batch. Each row is marked published only after its own SQS confirmation. Failed sends remain unpublished. Empty polls and failures retain the two-second delay; productive batches continue immediately.

SQS clients are reused within each process so sends, receives, and deletes share their HTTP connection pool. The publisher still holds its PostgreSQL advisory lock on a single connection. Query execution on that connection has a ten-second socket timeout. After a failed batch or database operation, the publisher disconnects and reacquires leadership before continuing. Shutdown waits for the active batch before releasing the lock.

The cursor is process-local and resets on leader takeover. Selection is deterministic within a tenant, but concurrent sends and standard SQS do not guarantee delivery order. The ranking query scans pending outbox rows; its cost under a large sustained backlog needs measurement before introducing further database optimizations.

Run the repository integration test against a development database with no pending outbox rows. Fixtures and publication updates are rolled back:

```powershell
$env:RUN_DB_TESTS = '1'
bun test packages/worker/src/repositories/outbox.test.ts
Remove-Item Env:RUN_DB_TESTS
```

### Running the measurement

`bun run test:fairness` creates two tenants, runs three baseline requests, then submits 10,000 busy-tenant requests with concurrency 20 while submitting one quiet-tenant request per second. Requests rejected with HTTP 429 are counted separately and are not retried. This measures ingestion protection and delivery latency together; it does not claim that all 10,000 requests reached SQS.

The runner hosts a receiver at `RECEIVER_URL` and measures time from request submission to first webhook arrival. Duplicate deliveries do not inflate completion counts. Stop `dev:receiver` before running it. Use the development queue and keep unrelated producers and workers stopped during the measurement. The receiver acknowledges unrelated messages but counts them separately.

Start PostgreSQL and Redis, then run the API, poller, and worker in separate terminals:

```powershell
docker compose up -d postgres redis
```

```powershell
bun run dev:api
```

```powershell
bun run dev:poller
```

```powershell
bun run dev:worker
```

Once those processes are running:

```powershell
bun run test:fairness
```

The worker and runner must use the same `RECEIVER_URL`. `API_URL` defaults to `http://127.0.0.1:3000/events`. Both URLs must be local HTTP endpoints. The runner leaves its tenants, events, and deliveries in the database for inspection. It does not purge the queue or remove existing data.

| Environment variable | Default | Meaning |
|---|---|---|
| `FAIRNESS_BUSY_REQUESTS` | `10000` | Busy-tenant request count |
| `FAIRNESS_CONCURRENCY` | `20` | Concurrent busy-tenant submissions |
| `FAIRNESS_QUIET_INTERVAL_MS` | `1000` | Delay between quiet-tenant submissions |
| `FAIRNESS_QUIET_P95_MS` | `30000` | Maximum quiet-tenant p95 arrival latency |
| `FAIRNESS_TIMEOUT_MS` | `600000` | Overall measurement deadline |
| `FAIRNESS_REPORT_PATH` | `logs/fairness-{runId}.json` | Report path, including per-request data |

The latency threshold is a test criterion, not a production SLO. Fix it before the run. A passing result requires a completed baseline, all requested busy submissions, at least one accepted busy event, at least three quiet submissions overlapping the busy burst, delivery of every accepted event, no rejected quiet requests, no request errors, and quiet-tenant p95 within the threshold. An incomplete run exits nonzero. Reports distinguish HTTP rejection, request failure, pending delivery, and completed delivery.

The runner stops its receiver when the measurement finishes. If the run times out, accepted events may remain in the pipeline. Start `dev:receiver` at the same URL to drain them before another run.

Validate the runner without sending events:

```powershell
bun test
bun run test:fairness --help
bun run node_modules/typescript/bin/tsc -p packages/shared/scripts/tsconfig.json --noEmit
```

## First measured run: 2026-10-17

Run ID: `9caac609-de5e-496c-afe1-b7bfa4b8141b`. Local report: `logs/fairness-phase5.json` (ignored by Git). API ran on port 3100 and the receiver on 4100, with one publisher and one delivery worker. Ingestion and dispatch used their default independent budgets of 10 tokens and 10 tokens/second. Runner settings were the defaults listed above.

| Traffic | Submitted | Accepted | HTTP 429 | Delivered | p95 arrival latency |
|---|---:|---:|---:|---:|---:|
| Quiet baseline | 3 | 3 | 0 | 3 | 5,193 ms |
| Busy burst | 10,000 | 147 | 9,853 | 147 | 224,275 ms |
| Quiet during burst | 13 | 13 | 0 | 13 | 226,352 ms |

All 13 quiet submissions overlapped the busy burst. There were no request errors, duplicate arrivals, unrelated deliveries, or receiver errors. The runner exited with failure because quiet-tenant p95 exceeded 30,000 ms. With 13 samples, the nearest-rank p95 is also the maximum; this is a checkpoint measurement rather than a statistically robust latency benchmark.

A database inspection during the drain found 55 busy-tenant events and 5 quiet-tenant events still unpublished. The final inspection confirmed all 163 accepted events, including the baseline, had `SUCCEEDED` deliveries and no unpublished outbox rows remained for the test tenants.

The observed backlog includes the outbox publisher, before SQS dispatch limits apply. Publication is sequential, selects globally oldest rows, and waits two seconds between batches of ten. These are the next paths to inspect. This run does not isolate their individual contribution from AWS request latency or worker processing time.

The ingestion limiter rejected most busy submissions, so this run covers 10,000 attempted requests, not 10,000 accepted queue messages. A separate dispatch-pressure run will be needed to validate behavior with a sustained SQS backlog after the publisher issue is addressed.

## Worker acknowledgements

The worker fetches up to ten messages per receive. Webhook calls, circuit updates, and delivery-state writes remain sequential. Once a delivery is persisted as `SUCCEEDED`, its SQS delete can run concurrently with processing the next message. The worker waits for every outstanding delete before receiving another batch. This bounds concurrent acknowledgements to ten without introducing concurrent webhook attempts or circuit-breaker updates within one worker.

Delete failures are logged and leave the message eligible for redelivery. If a later receive finds an existing `SUCCEEDED` delivery, the worker retries deletion without repeating the webhook POST. Duplicates are still possible if a process fails after the receiver accepts a webhook but before success is persisted, or if multiple workers race on the same event.

The batch tests cover sequential delivery, overlapping acknowledgements, waiting for all confirmations, delivery and delete failures, and deferred messages. The fairness scenario uses a fast local receiver. Slow receivers and long S3 reads can still exceed the fixed 30-second visibility window; visibility renewal remains a hardening requirement before increasing deployment concurrency.

## Intermediate measurements

- Run `927095e5-f389-48eb-bc2e-38dd20ee114b` was affected by a PostgreSQL/Redis restart. Its report is `logs/fairness-phase5-after.json`. All accepted events eventually completed, but its latency is excluded from the comparison.
- Run `a1bf7205-a393-4a33-afd9-80316001a9df` was interrupted before report generation. A subsequent drain confirmed 182 busy and 19 quiet events, including baseline, all had successful deliveries and no unpublished outbox rows remained.
- Run `2fe46d51-73c1-461e-9982-25a36650d6c7` used the new publisher and overlapping acknowledgements with receive batches of five. All 252 accepted busy events and 24 quiet events, including baseline, arrived. Quiet load p95 was 35,632 ms, still above 30,000 ms. Its report is `logs/fairness-phase5-final.json`. Receive batches were then increased to ten for the next measurement.

## Passing measurement: 2026-10-18

Run ID: `6d7832b0-2531-42fb-befa-4947dc9ecb71`. Report: `logs/fairness-phase5-batch10.json`. The runner retained 10,000 busy requests, concurrency 20, one quiet request per second, a 30,000 ms quiet p95 threshold, and a 600,000 ms deadline. Tenant budgets remained at their defaults. One publisher and one worker ran on the same development infrastructure as before, with the API on 3100 and receiver on 4100.

| Traffic | Submitted | Accepted | HTTP 429 | Delivered | p95 arrival latency |
|---|---:|---:|---:|---:|---:|
| Quiet baseline | 3 | 3 | 0 | 3 | 2,226 ms |
| Busy burst | 10,000 | 246 | 9,754 | 246 | 30,568 ms |
| Quiet during burst | 21 | 21 | 0 | 21 | 25,663 ms |

Quiet-tenant p95 decreased from 226,352 ms to 25,663 ms. Its maximum latency was 26,997 ms. All 21 quiet submissions overlapped the busy burst. There were no request errors, duplicate arrivals, unrelated messages, receiver errors, or pending deliveries. A final database check confirmed all 270 accepted events had successful deliveries and no unpublished outbox rows remained for these tenants.

The number of accepted busy events differs between runs because the burst duration and token refill timing differ. This is a comparison under identical request-count, concurrency, and rate-limit settings, not identical accepted queue volume. The passing result applies to this run; it is not a general latency guarantee.

A second publisher was also checked during the preceding run and remained on standby while the leader held the advisory lock. Final validation passed all 15 tests, including the opt-in PostgreSQL repository test. Worker, shared library, and fairness-runner TypeScript checks passed. Test processes were stopped after delivery completion; PostgreSQL and Redis were left running.
