# Phase 5 - Rate limiting and tenant fairness

The first fairness test showed that per-tenant rate limits were not enough: quiet-tenant p95 reached 226 seconds. Publisher scheduling and worker changes brought the request-burst result below 30 seconds. A separate test with 1,000 accepted events exposed another delay in dispatch. Explicit tenant turns brought that test below 30 seconds too, at the cost of slower busy-tenant completion.

## Independent budgets

Ingestion and delivery use separate Redis token buckets for each tenant:

- `waybill:rate-limit:ingestion:tenant:{tenantId}`
- `waybill:rate-limit:delivery:tenant:{tenantId}`

Both paths previously consumed the same bucket. An ingestion burst could exhaust the tokens required to dispatch accepted events. Different ingestion and delivery configurations also operated on the same stored state.

The shared limiter now requires a scope at each call site. Each bucket still uses the existing atomic Lua script for refill and consumption. The default capacity and refill rate are 10 tokens and 10 tokens per second for each scope. The four configuration variables are listed in `.env.example`.

Ingestion returns HTTP 429 with `Retry-After` when its bucket is exhausted. The worker defers rate-limited messages using `ChangeMessageVisibility` without incrementing the delivery attempt count.

Existing unscoped keys expire through their TTL. New scoped keys start with full capacity, so deploying this change resets the available burst budget once.

## Limiter tests

The limiter tests verify burst exhaustion, refill, and isolation between scopes and tenants. The isolation test uses an in-memory implementation of the Redis EVAL interface to check key routing. It does not verify Lua execution, concurrent Redis access, or SQS scheduling.

## Limits of these results

The request-burst and 1,000-accepted-event scenarios pass the local p95 criterion. The latest run still had a 63,544 ms quiet maximum and a 513,619 ms busy maximum. Further work should reduce latency tails and quantify the busy-throughput cost before treating this as a production service guarantee. Measurements use one worker and a fast local receiver; larger accepted workloads remain unmeasured.

Token-bucket unit tests check the limiter. Fairness has to be measured across the API, outbox poller, Redis, SQS, worker, and receiver because delays can occur before or after the bucket check.

## Fairness runner

### Publisher changes

Pending outbox rows are ranked by `(created_at, id)` within each tenant. Selection takes each tenant's first pending row before taking second rows. A tenant cursor rotates the starting point between batches, including when more tenants are pending than the batch limit. Ranking happens before the global limit, so a quiet tenant is not excluded by a large older backlog.

The publisher sends at most ten messages concurrently and waits for every result before selecting the next batch. Each row is marked published only after its own SQS confirmation. Failed sends remain unpublished. Empty polls and failures retain the two-second delay; productive batches continue immediately.

SQS clients are reused within each process so sends, receives, and deletes share their HTTP connection pool. The publisher still holds its PostgreSQL advisory lock on a single connection. Query execution on that connection has a ten-second socket timeout. After a failed batch or database operation, the publisher disconnects and reacquires leadership before continuing. Shutdown waits for the active batch before releasing the lock.

The cursor is process-local and resets on leader takeover. Selection is deterministic within a tenant, but concurrent sends and standard SQS do not guarantee delivery order. The ranking query scans pending outbox rows; its cost under a large sustained backlog needs measurement before introducing further database optimizations.

Run the repository integration test against a development database with no pending outbox rows. Fixtures and publication updates are rolled back:

```bash
RUN_DB_TESTS=1 bun test packages/worker/src/repositories/outbox.test.ts
```

### Running the measurement

`bun run test:fairness` creates two tenants, runs three baseline requests, then submits 10,000 busy-tenant requests with concurrency 20 while submitting one quiet-tenant request per second. Requests rejected with HTTP 429 are counted separately and are not retried. This measures ingestion protection and delivery latency together. Only accepted requests enter the delivery pipeline.

The runner hosts a receiver at `RECEIVER_URL` and measures time from request submission to first webhook arrival. Duplicate deliveries do not inflate completion counts. Stop `dev:receiver` before running it. Use the development queue and keep unrelated producers and workers stopped during the measurement. The receiver acknowledges unrelated messages but counts them separately.

Start PostgreSQL and Redis, then run the API, poller, and worker in separate terminals:

```bash
docker compose up -d postgres redis
```

```bash
bun run dev:api
```

```bash
bun run dev:poller
```

```bash
bun run dev:worker
```

Once those processes are running:

```bash
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

The latency threshold is a test criterion, not a production SLO. Set it before the run. A passing result requires a completed baseline, all requested busy submissions, at least one accepted busy event, at least three quiet submissions overlapping the busy burst, delivery of every accepted event, no rejected quiet requests, no request errors, and quiet-tenant p95 within the threshold. An incomplete run exits nonzero. Reports distinguish HTTP rejection, request failure, pending delivery, and completed delivery.

The runner stops its receiver when the measurement finishes. A timeout can leave accepted events in the pipeline. Remaining work needs to drain before another run, using a test receiver that accepts the generated tenants. The Phase 6 example receiver accepts only its configured tenant, so it cannot drain all fairness-test traffic.

Local checks without submitting events:

```bash
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

All 13 quiet submissions overlapped the busy burst. There were no request errors, duplicate arrivals, unrelated deliveries, or receiver errors. The runner exited with failure because quiet-tenant p95 exceeded 30,000 ms. With 13 samples, the nearest-rank p95 is also the maximum. The sample is too small for a statistically robust latency benchmark.

A database inspection during the drain found 55 busy-tenant events and 5 quiet-tenant events still unpublished. The final inspection confirmed all 163 accepted events, including the baseline, had `SUCCEEDED` deliveries and no unpublished outbox rows remained for the test tenants.

The backlog included the outbox publisher, before SQS dispatch limits applied. At that point, publication was sequential, selected globally oldest rows, and waited two seconds between batches of ten. That made the publisher a bottleneck to investigate. The run did not isolate its contribution from AWS request latency or worker processing time.

The ingestion limiter rejected most busy submissions, so this run covers 10,000 attempted requests, not 10,000 accepted queue messages. This led to the accepted-backlog test below, which queues the busy workload before starting dispatch.

## Worker acknowledgements

Each receive returns up to ten messages. Webhook calls, circuit updates, and delivery-state writes remain sequential. Once a delivery is persisted as `SUCCEEDED`, its SQS delete can run concurrently with processing the next message. The worker waits for the outstanding deletes before processing the next response batch. This bounds concurrent acknowledgements to ten without introducing concurrent webhook attempts or circuit-breaker updates within one worker.

Delete failures are logged and leave the message eligible for redelivery. If a later receive finds an existing `SUCCEEDED` delivery, the worker retries deletion without repeating the webhook POST. Duplicates are still possible if a process fails after the receiver accepts a webhook but before success is persisted, or if multiple workers race on the same event.

The batch tests cover sequential delivery, overlapping acknowledgements, waiting for all confirmations, delivery and delete failures, and deferred messages. The fairness scenario uses a fast local receiver. At this stage there was no visibility renewal, so a slow receiver or S3 read could outlast the 30-second reservation. The later receive-buffer changes added renewal; a failed renewal during an active HTTP request can still lead to duplicate delivery.

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

A second publisher remained on standby while the leader held the advisory lock. The 15 tests available at that point passed, including the PostgreSQL repository test, along with worker, shared, and runner type checks.

## Accepted-backlog runner

`bun run test:fairness:backlog` separates dispatch fairness from ingestion rejection. It defaults to 1,000 accepted busy-tenant events, with a 15-minute overall deadline and the existing 30-second quiet-tenant p95 criterion. `FAIRNESS_BUSY_REQUESTS` can increase the preload for larger runs.

This mode owns the delivery worker. Start only the API and poller externally, with no other consumers or producers using the development queue. The runner refuses to preload if the queue or outbox already contains pending work. It never purges existing messages.

The runner starts a worker for the three-request quiet baseline, waits for the queue to drain, and stops that worker. It then requires every busy request to receive HTTP 201, waits for all busy outbox entries to be published, and records an SQS visible-message estimate at least as large as the preload. Delivery restarts only after those checks pass. Queue counts are approximate; the publication confirmations and controlled worker lifecycle provide additional evidence that the workload was queued before dispatch.

Quiet requests continue at one per second while accepted busy events remain undelivered. Each probe records the number of busy events whose first arrival has not yet been observed. At least three quiet probes must overlap outstanding busy deliveries. Missing preload evidence, any rejected preload request, missing deliveries, unrelated traffic, or quiet p95 above the threshold causes failure.

For a local run, use separate terminals from the repository root:

```bash
docker compose up -d postgres redis
```

```bash
API_PORT=3100 INGESTION_RATE_LIMIT_CAPACITY=2000 INGESTION_RATE_LIMIT_REFILL_PER_SECOND=1000 bun run packages/api/src/index.ts
```

```bash
bun run packages/worker/src/outbox-poller.ts
```

```bash
API_URL=http://127.0.0.1:3100/events RECEIVER_URL=http://127.0.0.1:4100/webhook bun run test:fairness:backlog
```

The larger intake budget applies only to the test API process. Normal delivery limits are inherited unchanged by the owned worker. For larger preloads, size the test API intake allowance accordingly. Do not start `dev:worker` or `dev:receiver` alongside this mode. Worker output is written to `logs/fairness-worker-{runId}.log` and `.error.log`.

The report includes its mode, publication and queue evidence, and per-probe backlog observations. On completion, the runner waits for queue drain before stopping its worker and receiver. Interrupted or failed runs preserve their accepted events; drain any remaining work before another measurement. Test tenants and delivery records remain available for inspection.

## Accepted-backlog measurement: 2026-10-22

Run ID: `b8b57c2c-837f-47e5-8f03-caf497d2346e`. Report: `logs/fairness-backlog-2026-10-22.json`. The run confirmed 1,000 published busy-tenant outbox entries and an SQS visible-message estimate of 1,000 before starting dispatch. API and receiver ports were 3100 and 4100. The test API used capacity 2,000 and refill 1,000/second; the worker retained its default capacity 10 and refill 10/second. One publisher and one runner-managed worker ran on the Mac.

| Traffic | Submitted | Accepted | HTTP 429 | Delivered | p95 arrival latency |
|---|---:|---:|---:|---:|---:|
| Quiet baseline | 3 | 3 | 0 | 3 | 2,617 ms |
| Busy preload | 1,000 | 1,000 | 0 | 1,000 | 166,264 ms |
| Quiet during dispatch | 133 | 133 | 0 | 133 | 106,898 ms |

All 133 quiet probes overlapped outstanding busy deliveries. Quiet maximum latency was 130,123 ms. There were no request errors, duplicate arrivals, unrelated messages, receiver errors, or pending deliveries. The runner exited nonzero because quiet p95 exceeded the predeclared 30,000 ms threshold. Busy latency includes the preload/publication period while the worker was stopped, so it is not a dispatch-only measurement.

The database check confirmed all 1,136 accepted events, including baseline, had successful delivery records and no unpublished outbox rows remained for the test tenants. The queue drained completely.

This run isolates a remaining dispatch problem: the full busy workload was already published before quiet load began. Publisher tenant rotation cannot schedule messages that are already in SQS. A token bucket caps a tenant's delivery rate but does not by itself guarantee prompt service for another tenant in the shared queue. This shifted the investigation to the worker's receive and defer behavior.

The test reproduced the problem with 1,000 accepted events on the Mac, independently of ingestion rejection. It does not establish a result for 10,000 accepted events or support a direct comparison with the old laptop.

## SQS tenant grouping

The publisher now sets `MessageGroupId` to the event's `tenantId` on every send. The JSON body and existing `tenantId` message attribute are retained. The [SQS SendMessage reference](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessage.html) documents this property for standard queues as well as FIFO queues.

On a standard queue, this activates tenant-aware scheduling. The [AWS fair queue guide](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fair-queues.html) describes how SQS favors quiet tenants when another tenant dominates processing. Redis token buckets still enforce the dispatch rate; scheduling and rate limits serve different purposes. The existing standard queue, worker receive path, and delivery limits are retained.

The [detailed behavior reference](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fair-queues-detailed.html) describes detection based on in-flight concurrency and recent processing-time share. Detection is approximate. This does not establish a strict per-tenant delivery order or a fixed latency guarantee. FIFO ordering remains outside Phase 5.

The repository test now checks distinct tenants' group IDs, consistency with the message body and attribute, persistence after confirmation, and unchanged pending state on send failure. Older queued messages are not relabeled by this source change, so the comparison uses a drained queue and a fresh preload. Future replay sends must use the same tenant grouping.

## Bounded receive buffer and visibility renewal

Tenant grouping by itself did not meet the local test criterion. Run `f53c341d-c6dd-4d70-a73e-2e4be9c04f36` delivered all 1,000 busy events and 125 quiet load events, but quiet p95 was 108,419 ms. Its report is `logs/fairness-backlog-grouped-2026-10-22.json`.

The worker now runs ten concurrent long polls, each fetching up to ten messages, with at most one hundred fetched messages per cycle. Responses are processed as they arrive; an empty long poll does not block an already-available response. HTTP calls and durable delivery writes remain sequential. The receive buffer gives SQS visibility into reserved work while retaining a bounded amount of local state. This changed consumer capacity as well as producer metadata, so the subsequent measurements include both changes.

Buffered receipts are renewed every ten seconds using visibility batches of at most ten entries. Each call has an eight-second deadline. Individual failed or missing confirmations invalidate the affected local ownership. An expired or uncertain receipt is skipped before starting a delivery, allowing SQS to redeliver it later. A failure during an already-started HTTP request can still result in duplicate delivery; this remains an at-least-once system.

Before setting a retry/circuit/rate-limit delay or deleting a message, the worker removes its receipt from renewal and waits for any pending renewal to finish. This prevents a late heartbeat from overriding a deliberately chosen visibility delay. Completed delete requests remain bounded to the ten-message response being processed. Neither webhook calls nor circuit-state writes are processed concurrently within a worker.

The renewal tests cover ten-entry batching, exclusion of released receipts, renewal/release races, individual failures, request failures, and expired ownership. The worker uses existing SQS operations; the IAM policy must permit visibility changes through the batch operation as well as the existing delivery operations.

## Explicit dispatch turns

Tenant metadata and a larger receive buffer were insufficient on their own in the single-worker scenario:

| Configuration | Quiet p95 | Report |
|---|---:|---|
| Tenant grouping, original receive loop | 108,419 ms | `logs/fairness-backlog-grouped-2026-10-22.json` |
| Tenant grouping, buffer up to 40 | 91,254 ms | `logs/fairness-backlog-prefetch-2026-10-22.json` |
| Tenant grouping, buffer up to 100 | 89,788 ms | `logs/fairness-backlog-buffer100-2026-10-22.json` |

The worker now limits selections to ten messages per tenant in each bounded receive cycle. Excess messages are deferred for thirty seconds using visibility batches of at most ten entries. Deferrals are sent concurrently after releasing the affected renewal leases. Every batch response is checked for per-entry failures and missing confirmations; errors leave messages eligible for later redelivery and are logged.

This limit controls how long a busy tenant occupies the local dispatch turn. It is separate from the Redis bucket, which still caps attempt rate across workers. The worker can scan past excess busy messages without posting all of them or making an individual SQS call for each deferral. Fairness deferrals do not create delivery attempts, consume retry budget, or delete messages.

The receive buffer remains bounded at one hundred messages, while HTTP delivery stays sequential. Busy-tenant completion may take longer because excess work is intentionally delayed to leave room for other tenants. There is no strict bound on latency for arbitrary backlog sizes, destination latency, or tenant counts; the unchanged local test criterion must still be measured.

The dispatch-turn tests cover a quiet tenant behind one hundred busy selections, independent per-tenant budgets, conservation of ready/deferred selections, and reset between cycles. The turn budget is held in worker memory; it does not require another queue or database table.

## Passing worker-turn measurement: 2026-10-22

Run ID: `44338920-af5f-4eb1-8fc0-a59ab82a704a`. Report: `logs/fairness-backlog-turns-2026-10-22.json`. The runner retained the same 1,000-event accepted preload, request concurrency 20, one quiet submission per second, a 900,000 ms deadline, and the 30,000 ms quiet p95 criterion. API intake and worker token-bucket settings were unchanged from the failing backlog run.

The worker used tenant message groups, up to one hundred buffered messages, sequential HTTP delivery, a ten-message per-tenant selection budget per receive cycle, thirty-second batched fairness deferrals, and visibility renewal for buffered/active messages.

| Traffic | Submitted | Accepted | HTTP 429 | Delivered | p95 arrival latency | Maximum |
|---|---:|---:|---:|---:|---:|---:|
| Quiet baseline | 3 | 3 | 0 | 3 | 2,415 ms | 2,415 ms |
| Busy preload | 1,000 | 1,000 | 0 | 1,000 | 458,964 ms | 513,619 ms |
| Quiet during dispatch | 444 | 444 | 0 | 444 | 25,226 ms | 63,544 ms |

The runner confirmed all 1,000 busy messages published and visible before dispatch. All 444 quiet probes overlapped outstanding busy work. Every accepted event arrived, with no request errors, duplicate arrivals, unrelated messages, or receiver errors. The worker error log was empty. A final database check confirmed all 1,447 accepted events had successful delivery records, one attempt each, and no unpublished outbox rows remained for the test tenants.

This run passes the defined p95 criterion, not an every-request 30-second bound. Busy maximum latency increased from 188,318 ms in the original failing backlog run to 513,619 ms. Quiet probes continue until the busy backlog drains, so the longer completion period also increased the quiet sample count from 133 to 444. The latency improvement and throughput cost must be assessed together; these are equal-preload/configuration runs, not equal-duration or equal-quiet-sample experiments.

Grouping-only and buffer-only changes did not meet the criterion. The passing configuration includes explicit worker turns and batched deferrals as well as queue grouping and the bounded buffer; the result cannot be attributed to SQS grouping alone. Slow receivers, arbitrary tenant counts, and a fully accepted 10,000-event backlog are not validated by this measurement.

At the end of Phase 5, all 24 tests passed, including the PostgreSQL repository test, along with package and fairness-runner type checks. The queue drained completely.


## What I learned

Separate buckets prevent ingestion from consuming dispatch capacity, but they do not decide which tenant gets served next. Fairness depends on selection in the outbox, scheduling in SQS, and how much work the consumer reserves and processes.

The 10k-request test initially hid part of the dispatch problem because most busy requests received HTTP 429. Preloading accepted events made the shared-queue delay visible. Tenant grouping and a larger buffer helped, but the measured p95 only passed after adding explicit worker turns and batched deferrals.

The tradeoff is visible in the final numbers: quiet p95 fell to 25.2 seconds while busy maximum latency rose to 513.6 seconds. Passing p95 still left a quiet request waiting 63.5 seconds. Tail latency and busy-tenant throughput need separate attention.
