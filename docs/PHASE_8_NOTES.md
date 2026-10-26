# Phase 8 - Service metrics

## Scope and order

The Phase 7 backend is verified locally. The tenant dashboard will be connected after backend metrics, load testing, and hardening. Hosted replica provisioning stays with deployment.

API, publisher, worker, and background backlog collection are implemented. Local Prometheus, Grafana, and provisioned service panels are also implemented. Live delivery-flow monitoring and a scoped off/on overhead probe are verified. Sustained full-pipeline performance belongs to Phase 9. The public website is unchanged.

## Metric contract

Counters reset when their process restarts. They describe observed operations, not a replacement for PostgreSQL history or an exactly-once delivery count. Every registry has one fixed `service` label: `api`, `publisher`, or `worker`.

Tenant IDs, event IDs, request IDs, destinations, archive keys, cursor values, and error messages never become metric labels.

### Implemented

| Metric | Type / unit | Labels | Observation |
| --- | --- | --- | --- |
| `waybill_http_requests_total` | Counter / requests | operation, method, status_class | Once on response finish or connection closure |
| `waybill_http_request_duration_seconds` | Histogram / seconds | operation, method, status_class | Request entry through response finish or closure |
| `waybill_process_uptime_seconds` | Gauge / seconds | service only | Process uptime at scrape |
| `waybill_process_resident_memory_bytes` | Gauge / bytes | service only | Resident memory at scrape |
| `waybill_process_heap_used_bytes` | Gauge / bytes | service only | Used JavaScript heap at scrape |

`service` is also present on both HTTP metrics. The process gauges use Bun's process APIs; Node-specific GC and event-loop collectors are not enabled.

HTTP operations are `ingestion`, `history`, `summary`, `dead_letters`, `archive`, `replay`, `health`, and `unmatched`. These are fixed classifications of supported method/path shapes. An invalid tenant ID still belongs to its operation; it does not become a new label. Unknown paths share `unmatched`.

Methods are GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, or OTHER. Status classes are 1xx through 5xx, `other`, or `aborted`. A disconnected client is recorded as aborted, independently of whether backend work committed. A 202 replay response records an accepted HTTP command, not a delivery outcome.

HTTP histogram bucket boundaries, in seconds:

```text
0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, +Inf
```

Request instrumentation runs before JSON parsing, so malformed bodies are counted. The finish and close listeners share one completion guard. The scrape listener is separate from Express and does not add requests to these counters. Label combinations appear only after an observation.

### Publisher and worker metrics

These counters are wired into the existing send, database update, webhook, visibility, and acknowledgement boundaries. Labels remain fixed across tenants and destinations.

| Metric | Type / unit | Bounded labels | Observation boundary |
| --- | --- | --- | --- |
| `waybill_outbox_publications_total` | Counter / operations | outcome: published, already_published, send_failed, persist_failed | After send/update resolution; a zero-row update is already_published |
| `waybill_sqs_operations_total` | Counter / SDK operations | operation: send, receive, delete, change_visibility; outcome: success, failure | After the logical SDK operation resolves; incomplete batch confirmations count as failure, internal SDK retries do not count separately |
| `waybill_webhook_attempts_total` | Counter / attempts | outcome: success, failure | Completed postWebhook calls; preparation failures and completed redeliveries excluded |
| `waybill_webhook_duration_seconds` | Histogram / seconds | outcome: success, failure | Actual webhook call duration |
| `waybill_delivery_retries_total` | Counter / persisted retry decisions | reason: preparation, webhook | After the retry database update resolves; visibility-change success is tracked separately |
| `waybill_delivery_terminal_outcomes_total` | Counter / persistence observations | outcome: succeeded, dead_lettered | After terminal state persistence succeeds; not on a completed-message redelivery |
| `waybill_delivery_deferrals_total` | Counter / confirmed deferrals | reason: circuit_open, rate_limit, not_due, tenant_turn | Only after the relevant visibility change is confirmed |
| `waybill_buffered_reservations` | Gauge / receipts | service only | Current unexpired buffered ownership; failed renewal and expired receipts excluded |
### Cached backlog metrics

These four gauges are exported by each metrics-enabled publisher. Sampling runs separately from the scrape handler.

| Metric | Type / unit | Bounded labels | Observation boundary |
| --- | --- | --- | --- |
| `waybill_outbox_pending` | Gauge / rows | service only | Last successful bounded background sample |
| `waybill_sqs_messages` | Gauge / approximate messages | state: visible, in_flight, delayed | Last successful queue-attribute sample |
| `waybill_backlog_sample_success` | Gauge / 0 or 1 | source: outbox, sqs | Result of latest background sampling attempt |
| `waybill_backlog_sample_timestamp_seconds` | Gauge / Unix seconds | source: outbox, sqs | Timestamp of last successful sample |

Webhook histogram bucket boundaries, in seconds:

```text
0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 20, 30, +Inf
```

Terminal observations can differ from distinct durable outcomes if processes race or fail between operations. Reconcile with persisted records for durable totals. A failed SQS acknowledgement must not be counted as another webhook attempt. PostgreSQL counts and SQS approximate depths are sampled outside scrape requests, with separate freshness and failure signals. No scrape may query PostgreSQL, Redis, or AWS.

Neither the API nor webhook duration histogram measures ingestion-to-delivery latency. The load test must measure that separately.

## Running metrics

Metrics are disabled by default. Enable each local process in a separate terminal without changing `.env`:

```bash
METRICS_ENABLED=true bun run dev:api
METRICS_ENABLED=true bun run dev:poller
METRICS_ENABLED=true bun run dev:worker
```

| Process | Default scrape address | Port variable |
| --- | --- | --- |
| API | `http://127.0.0.1:9100/metrics` | `API_METRICS_PORT` |
| Publisher | `http://127.0.0.1:9101/metrics` | `PUBLISHER_METRICS_PORT` |
| Worker | `http://127.0.0.1:9102/metrics` | `WORKER_METRICS_PORT` |

For example:

```bash
curl --fail http://127.0.0.1:9100/metrics
```

Each port variable applies only to its process role. `METRICS_HOST` accepts only 127.0.0.1 or ::1. Public listener addresses are rejected. Docker Desktop reaches these host listeners through host.docker.internal; the application metrics listeners remain bound to loopback.

The scrape endpoint accepts only GET and returns Prometheus text with `Cache-Control: no-store`. Other paths return 404 and other methods return 405. Collection failures return 503. Scrapes only serialize local metrics and read process memory/uptime.

A metrics-port bind failure is logged and does not prevent the process from continuing startup. Invalid enabled configuration fails explicitly. Metrics collection does not depend on the application database, Redis, or queue. A successful scrape is not a readiness check for those dependencies. Stopping an external monitoring service does not disable these in-process counters.

## Publication, retry, and acknowledgement boundaries

A confirmed SendMessage increments the publisher's SQS send success even if the subsequent outbox update fails. Publication then records persist_failed, so a resend remains visible as at-least-once behavior. A zero-row update records already_published rather than claiming another published row. These counters observe update completion; a surrounding transaction could still roll back.

Webhook attempts and durations are observed when postWebhook returns, before circuit-state or delivery persistence. A successful HTTP response followed by a failed database update therefore remains a successful webhook attempt without a recorded terminal result. Preparation failures have no webhook attempt.

A retry increments after markFailed resolves, before changing visibility. A failed visibility change does not erase that persisted retry observation. Terminal results increment after markSucceeded or markDeadLettered resolves, before DeleteMessage. Deleting a completed redelivery only affects the SQS delete counter.

Visibility deferrals count confirmed receipts. A mixed-success batch counts one failed SQS batch operation and only its confirmed receipt deferrals. Duplicate, unknown, or explicitly failed entry IDs cannot inflate confirmed counts. Periodic visibility renewal affects the SQS operation counter, never the deferral counter. Buffered reservations read the local lease map and exclude expired or invalidated entries.

## Background backlog sampling

The publisher owns both backlog sources. With METRICS_ENABLED=true, each source samples immediately, then waits 30 seconds after its previous read settles before sampling again. Metrics-disabled processes create neither the sampling connection nor the queue-attribute requests. The API and delivery worker do not run extra backlog queries.

The sources run independently. A stalled outbox read does not block SQS sampling. Each source has at most one read in flight. A five-second deadline marks the source unsuccessful, aborts its request signal, and prevents late results from updating the cache. If an underlying operation is still settling, the sampler does not start another read for that source.

The outbox reader has its own primary connection, separate from the publisher's advisory-lock session. It uses a one-connection pool, a two-second connect timeout, a one-second pool wait, and a five-second socket timeout. Every count runs in a read-only transaction with a two-second statement timeout, a 500 ms lock timeout, and a four-second transaction timeout. Prisma does not expose query cancellation through AbortSignal; the database deadlines bound the underlying work, and the signal checks discard an expired result. Monitoring reads the primary's unpublished rows; tenant history and dashboard reads still use the replica.

The queue reader requests only ApproximateNumberOfMessages, ApproximateNumberOfMessagesNotVisible, and ApproximateNumberOfMessagesDelayed through GetQueueAttributes. All three attributes must be present and contain nonnegative safe integer counts. Missing or malformed values are failures, not zeroes. This call requires sqs:GetQueueAttributes on the existing queue; IAM policies have not been changed. Monitoring reads are separate from the publishing/delivery SQS operation counters.

SQS counts are approximate and eventually consistent. Visibility-based retry backoff contributes to in-flight messages, not necessarily to delayed messages. The delayed count describes queue/message delay. These are queue states rather than a count of actively running webhook requests. See the [GetQueueAttributes definitions](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_GetQueueAttributes.html).

Before the first successful read, backlog values are NaN, source success is zero, and the successful-sample timestamp is zero. A failure keeps the last good count and timestamp while setting source success to zero. A later success updates all counts for that source together and records its completion time. A confirmed empty backlog is zero, which remains distinct from an unknown value.

Scrapes only serialize cached values. They never initiate PostgreSQL or SQS work. Monitoring panels must use the success flag and the age of the last successful timestamp alongside the count. Multiple publishers each observe the same global resources, including standby publishers; deduplicate fresh samples rather than summing their backlog gauges.

Stopping the sampler cancels timers, aborts pending reads, waits for the bounded underlying operations, and prevents further cache updates or scheduling. The publisher then closes the separate sampling pool before releasing its leader session and metrics listener.

## Local Prometheus and Grafana

The monitoring stack is in docker-compose.monitoring.yml, separate from the application Compose file. It starts only Prometheus and Grafana. It does not start PostgreSQL, Redis, the API, publisher, or worker.

The pinned images are [Prometheus 3.15.1](https://github.com/prometheus/prometheus/releases/tag/v3.15.1) and [Grafana OSS 13.2.4](https://github.com/grafana/grafana/releases/tag/v13.2.4). No Grafana plugins are installed by the setup.

```bash
bun run monitoring:up
```

| Interface | Address |
| --- | --- |
| Grafana dashboard | http://127.0.0.1:3300/d/waybill-services |
| Prometheus | http://127.0.0.1:9090 |

On first use, the setup creates .env.monitoring with a generated admin password and mode 0600. The file is ignored by Git; .env.monitoring.example is a template. Existing credentials are preserved. Open the local file to sign in. Grafana stores the account in its database, so editing the environment file later does not reset an existing account's password.

Anonymous access and user signup are disabled. Data source requests go through Grafana's server-side proxy. Both published monitoring ports bind to 127.0.0.1. Application metrics remain loopback-only. Prometheus itself has no login in this local-only setup.

Prometheus and Grafana use their own named volumes. Prometheus keeps at most seven days of block data with a 256 MB size retention setting. This does not cap all disk usage: the head and write-ahead log need additional space. Container memory limits are 384 MB for Prometheus and 512 MB for Grafana; CPU limits are 0.5 and 0.75 respectively. Container logs rotate at 10 MB with two files per service. These are configured limits, not measured instrumentation overhead.

Prometheus scrapes the API, publisher, and worker every 15 seconds with a five-second timeout. Rule evaluation also runs every 15 seconds. Targets use host.docker.internal on Docker Desktop and ports 9100, 9101, and 9102. This was verified on the current Mac. Native Linux host-loopback routing is not configured by this file. Custom application metrics ports also need matching target edits in prometheus.yml.

Run the real processes in separate terminals when the development dependencies are ready:

```bash
METRICS_ENABLED=true bun run dev:api
METRICS_ENABLED=true bun run dev:poller
METRICS_ENABLED=true bun run dev:worker
```

A target showing DOWN means its scrape failed. A target showing UP only confirms that metrics can be read; it does not prove PostgreSQL, Redis, SQS, or webhook readiness. The separate production-readiness checkpoint still applies.

### Files and panels

Prometheus configuration, recording rules, and rule tests are under infra/monitoring/prometheus. Grafana data source and dashboard providers are under infra/monitoring/grafana/provisioning. The dashboard JSON is under infra/monitoring/grafana/dashboards. Provisioned definitions are the source of truth; saved Grafana UI edits are disabled for this provider.

The 18 panels cover target status, API throughput and errors, API p95 duration, webhook throughput and p95 duration, retries, terminal updates, deferrals, buffered ownership, publication results, SQS operation results, pending outbox rows, approximate queue depth, sampling success and age, resident memory, and uptime. Rates use Grafana's rate interval. Duration panels do not claim end-to-end delivery latency. Nonnegative chart axes start at zero.

The two backlog recording rules require a reachable publisher, a successful source sample, and a timestamp between zero and 90 seconds old. A never-sampled or future timestamp is rejected. Multiple publishers are deduplicated with max, not summed. Missing or stale backlog stays absent rather than being replaced with zero. Historical graphs can still show earlier valid observations; current target status and sample-age panels explain why current data is missing.

### Validation commands

```bash
bun run monitoring:check
```

This validates Compose, Prometheus configuration, and ten recording-rule cases. It uses short-lived promtool containers and does not start the long-running monitoring services.

```bash
bun run test:monitoring
```

The controlled check needs monitoring running and ports 9100-9102 free. It temporarily starts metric exporters using the real registry code and a fixed verification=true label. It records fixture observations directly, without calling databases, Redis, receivers, SQS, or S3. This verifies monitoring queries and connections, not the live delivery pipeline. It does not stop or replace existing application listeners.

The check confirms three UP targets, data for every panel query, Grafana login requirements, dashboard provisioning, data source health, and a query through the Grafana proxy. It then stops its exporters and checks that targets become DOWN and fresh backlog disappears. Fixture history remains identifiable by verification=true until retention removes it; choose the relevant time interval when examining real runs.

```bash
bun run monitoring:down
```

This stops only the monitoring stack and preserves its volumes. It does not stop application processes or remove application data.

## Validation

Focused HTTP tests cover 429 responses, malformed JSON, unavailable replica responses, accepted replay responses, unknown paths, bounded labels, and client disconnects. These use local fixtures and do not call PostgreSQL or AWS. They check that finish plus close does not double-count and that API requests still work after stopping the metrics listener.

Registry tests cover independent instances, histogram values, opt-in configuration, loopback binding restrictions, allowed scrape methods, and collection failure responses. The actual API process passed startup checks with metrics enabled and disabled. An occupied metrics port produced the expected error log while `/health` still returned 200. The scrape worked on the separate listener, and `/metrics` on the application port returned 404. Temporary test processes stopped afterward.

`bun run check:backend` passed all four configurations. `bun run test:backend` passed 89 tests, with four opt-in database suites skipped. The outbox publication and backlog database suites then passed separately against a fresh temporary PostgreSQL instance. The replica and replay suites were not rerun for this change.

Twenty isolated publisher/worker scenarios passed with mocked database, Redis, and AWS boundaries and a real local webhook receiver. Cases cover send failure, persistence failure, a duplicate publication, successful delivery, delete failure followed by redelivery, retry visibility failure, preparation failure, retry exhaustion, archive failure, terminal persistence failure, circuit/rate/not-due deferrals, partial batch success, and malformed queue input. Module mocks run in child processes so they cannot affect other backend tests.

The actual publisher and worker entry points each returned 200 from their metrics listener while application dependencies were isolated and unavailable or still initializing. The smoke checks did not publish, consume, or change development data. Temporary processes stopped afterward. This verifies startup and local scraping, not service readiness or a full live delivery run.

Sampler tests cover initial unknown values, real zeroes, invalid counts, atomic queue updates, cached HTTP scrapes, source independence, failure recovery, deadline reporting, non-overlapping reads, late-result rejection, and cancellation during shutdown. Queue-reader tests check exact attribute selection, signal propagation, missing/malformed values, and a response arriving after cancellation.

The database test applied the three existing migrations to a fresh PostgreSQL 16 instance, counted unpublished and published fixtures, confirmed changes in the count, and recovered after an exclusive table lock triggered the reader's bounded wait. The backlog database test finished in about 559 ms, including that deliberate lock wait. Fixtures, container, and volume were removed. CI now includes this suite with RUN_BACKLOG_DB_TESTS=1 and no publisher running.

Monitoring verification passed with the controlled exporters: all three targets were UP, every query across the 18 panels returned data, and authenticated Grafana proxy queries returned the expected fresh backlog. Anonymous dashboard access returned 401. After exporters stopped, all three targets became DOWN and the fresh backlog recording rule returned no series.

All ten promtool cases passed, including fresh data, true zero, failed samples, missing/down publishers, the exact 90-second stale boundary, future timestamps, and publisher deduplication. Both monitoring containers were recreated once: recorded Prometheus fixture history, Grafana credentials, the data source, and dashboard provisioning survived. The credential file remained ignored and mode 0600.

A headless Chrome check at 1536 by 1000 rendered the dashboard with no horizontal overflow, panel error text, or runtime exceptions. The screenshot is local under logs/monitoring-dashboard.png. Temporary browser and exporter processes stopped. Prometheus and Grafana remain running; real application targets are DOWN until those processes start with metrics enabled.

All backend and script TypeScript checks passed after adding the monitoring commands. Live AWS queue sampling, scenario counters, outage behavior, and the scoped overhead results are recorded below.

The client dependency is pinned to `prom-client` 15.1.3. Registry, counter, histogram, and gauge behavior follows the [client documentation](https://github.com/siimon/prom-client/tree/v15.1.3).

## Live monitoring flow: 2026-10-26

```bash
bun run test:monitoring:flow
```

This command uses the actual local API, publisher, and worker with the configured development SQS queue and an existing S3 archive. It requires the local primary on port 15432, Redis, running monitoring services, a configured development tenant with an S3-backed event, an empty queue/outbox, and no other publisher or consumers. Ports 3108 and 9100-9102 must be free. It creates its own signed receiver and test records; it does not replace an existing application process.

For the controlled failure case, the owned worker uses a three-attempt limit and a one-token delivery bucket refilling at 0.5 tokens/second. The owned API uses a two-token ingestion bucket refilling at one token/second. These overrides keep the test small and force the selected cases. The normal eight-attempt default and application configuration are unchanged.

The failed-delivery fixture points to the configured tenant's existing archive. The worker reuses that pointer when creating the dead-letter record. No S3 objects are uploaded, changed, or deleted. The source event, tenant, and archived payload are unchanged.

| Observation | Result |
| --- | --- |
| Concurrent ingestion burst | 2 accepted, 8 rejected with 429 |
| Controlled receiver failure | Second webhook call succeeded |
| Retry exhaustion fixture | 3 attempts, then DEAD_LETTERED |
| Two concurrent replay requests with one key | One new event and one delivered replay |
| Original failed fixture after replay | Still DEAD_LETTERED with 3 attempts |
| Completed-message redelivery | Acknowledged without another webhook attempt or terminal update |
| Receiver signature rejections | 0 |
| Total webhook calls | 9 |
| Terminal-state updates | 6 |
| Persisted retry observations | 3 |
| Confirmed delivery rate deferrals | 3 |
| Live SQS backlog sampling | Successful |
| Prometheus and Grafana stopped | New ingestion and signed delivery still succeeded |

Prometheus collects on a 15-second interval, so a completed fast scenario can be missed if its process exits before the next scrape. The runner now waits until Prometheus values match the actual API, publisher, and worker counters before the outage check and again after monitoring restarts. Both checks passed, including the two accepted replay responses. Fixture-labeled monitoring data is excluded from these assertions.

Monitoring was restored after the outage. The owned API, publisher, worker, and receiver stopped, and test records were removed only after successful delivery and queue drain. The final read-only check found an empty outbox and queue, no test tenants, and no events under either live-test run prefix. If a later run fails after publication begins, its accepted work is preserved for inspection rather than deleting records behind queue messages.

The completed report is under logs/monitoring-flow-dbd99489-9aa3-44a0-83f0-42d0c7e6979a-result.json. Process logs and a recovery manifest are kept under the same run prefix without secrets or payload contents. PostgreSQL, Redis, Prometheus, and Grafana remain running locally.

## Off/on overhead probe: 2026-10-26

```bash
bun run test:monitoring:overhead
```

The workload was fixed before measurement: eight trials in OFF, ON, ON, OFF, OFF, ON, ON, OFF order; 25 warmup calls and 250 measured calls per trial. API concurrency was four, and signed webhook concurrency was one. Each enabled trial included two explicit local metric scrapes. Samples, warmups, body size, and concurrency were identical between modes.

The API probe uses real PostgreSQL event/outbox writes and Redis ingestion checks. It holds the publisher advisory lock throughout and cleans up its own unpublished rows before releasing it, so none of these events are sent to AWS. The API's test ingestion budget is raised equally in both modes to avoid rate-limit rejection. No worker or publisher runs during the probe.

The webhook probe invokes postWebhook against a local receiver that verifies the HMAC signature. It compares the call with and without the attempt counter, duration histogram, and two scrape requests. It excludes worker persistence, retries, visibility renewal, SQS, and background backlog sampling. Metrics use ports 19100 and 19102, separate from the configured Prometheus targets.

| Trial | Metrics | API req/s | API p95 ms | Signed HTTP req/s | Signed HTTP p95 ms |
| --- | --- | --- | --- | --- | --- |
| 1 | OFF | 1816.3 | 3.003 | 29643.1 | 0.0424 |
| 2 | ON | 1861.9 | 3.018 | 24359.6 | 0.0464 |
| 3 | ON | 1939.8 | 2.917 | 26433.8 | 0.0434 |
| 4 | OFF | 1934.2 | 3.005 | 27095.3 | 0.0454 |
| 5 | OFF | 1877.2 | 2.890 | 31597.7 | 0.0403 |
| 6 | ON | 1914.9 | 2.612 | 27099.0 | 0.0427 |
| 7 | ON | 1792.2 | 2.914 | 27320.2 | 0.0416 |
| 8 | OFF | 1893.5 | 2.893 | 28350.2 | 0.0409 |

| Median across four trials per mode | Metrics OFF | Metrics ON |
| --- | --- | --- |
| API req/s | 1885.4 | 1888.4 |
| API p95 ms | 2.948 | 2.915 |
| Signed HTTP req/s | 28996.6 | 26766.4 |
| Signed HTTP p95 ms | 0.0417 | 0.0431 |

API median throughput differed by +0.16 percent with metrics enabled, while p95 differed by -1.10 percent. The trial ranges overlap, so this is not evidence of a speed improvement. The local signed HTTP probe showed a 7.69 percent throughput drop and a 3.40 percent p95 increase. Its p95 changed from about 41.7 to 43.1 microseconds.

These are small local component measurements on Bun 1.4.3 on this Mac, not sustained capacity results or a full worker overhead estimate. The API probe excludes publication and delivery; the webhook probe excludes database and queue work. Sampling queries and Prometheus/Grafana resource consumption were not measured by these latency probes. Phase 9 needs a fixed full-pipeline workload, accepted-volume checks, end-to-end latency, sampling/collector resource measurements, and longer runs.

The full report, including all trials and process resource observations, is logs/monitoring-overhead-c366bc22-230d-4dcd-b77f-fcd05f68430d.json. API process CPU and peak memory cover startup and warmup as well as measurement. A CPU reporting conversion was corrected for Bun's runtime BigInt counters before the complete run; the partial failed run is not included in the table.

All probe fixtures were removed. The final backend regression run passed 89 tests with four opt-in database suites skipped; all backend/script type configurations passed. Local Phase 8 checks are complete with the performance scope above. The tenant dashboard remains deferred.
