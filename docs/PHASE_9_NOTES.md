# Phase 9: Load testing and hardening

## First checkpoint: sustained baseline

The Phase 8 overhead probe measured API ingestion and signed HTTP calls separately. It excluded the complete worker loop, real SQS traffic, background backlog sampling, and the monitoring containers running together. This baseline includes those parts.

I am using a Bun fixed-arrival HTTP generator instead of adding another load-testing dependency. Each request has a scheduled time. The concurrency limit bounds outstanding HTTP calls; reaching it records a missed request rather than silently reducing the offered load. Schedule lag is also measured. This is a local pipeline baseline, not a maximum-capacity claim.

```bash
bun run test:load --help
bun run test:load
```

Start Docker, PostgreSQL, Redis, and the Phase 8 monitoring services first. Stop other publishers and queue consumers. The runner checks the local primary on port 15432, the publisher advisory lock, free API/metrics ports, and an empty development queue and outbox. It owns a temporary API on port 3110, publisher, worker, signed receiver, and test tenants. It does not restart the website or use the tenant dashboard.

### Workload declared before execution

| Setting | Default |
| --- | --- |
| Arrival rate and duration | 5 requests/second for 60 seconds, 300 requests |
| Maximum outstanding requests | 20 |
| Tenant mix | 3 tenants, round-robin, 100 requests each |
| Payload | 1,024 ASCII data bytes plus run ID and sequence JSON fields |
| Receiver | Local HTTP, verified HMAC, HTTP 200, no added delay |
| Ingestion budget per tenant | Capacity 20, refill 10/second |
| Delivery budget per tenant | Capacity 10, refill 10/second |
| Required accepted volume | All 300 requests |
| Per-tenant request-to-receiver p95 | At most 30 seconds |
| Per-tenant maximum delivery latency | At most 90 seconds |
| Maximum generator schedule lag | 250 ms |
| Terminal-outcome wait after submissions | At most 180 seconds |
| Queue drain wait after terminal outcomes | At most another 180 seconds |
| Resource sample interval | Approximately 10 seconds plus collection time |

`LOAD_DURATION_SECONDS`, `LOAD_RATE`, `LOAD_CONCURRENCY`, `LOAD_TENANTS`, `LOAD_PAYLOAD_BYTES`, `LOAD_RECEIVER_DELAY_MS`, `LOAD_DRAIN_SECONDS`, `LOAD_P95_MS`, `LOAD_MAX_MS`, and `LOAD_SCHEDULE_LAG_MS` override these settings. Every run saves its resolved configuration and pass criteria before creating test traffic. Keep configuration unchanged when comparing an implementation change.

The complete JSON payload is larger than its `data` field. This checkpoint uses inline payloads. Large payload/S3 behavior and deliberate receiver failures need separate workloads.

### Evidence and pass criteria

The runner records HTTP status, request start/completion, accepted event ID, signed receiver receipts, per-tenant delivery latency, and durable database outcomes. A 201 response without a usable event ID, a request timeout, or a missed scheduled request fails the run. These outcomes must not disappear from the denominator. HTTP 429 responses are reported separately and fail this all-accepted baseline.

Delivery latency starts immediately before the HTTP POST and ends at the receiver's first successful response, after any configured receiver delay. The database must also contain a matching `SUCCEEDED` outcome for every accepted event. Receiver latency and database persistence time are separate measurements. Duplicate webhook calls are counted because delivery is at least once; they are not counted as additional completed events.

The report records API throughput over the submission interval, completed-event throughput from the first submission to confirmed durable completion, completion drain time, and observed queue drain time. SQS depths are approximate. The runner waits for two consecutive empty observations at least 1.5 seconds apart, restarting that check when counts change, but these observations do not prove a queue can never redeliver an older message.

The API, publisher, and worker expose their normal Phase 8 metrics. The publisher keeps its background database and SQS samplers enabled. Before processes stop, Prometheus must store the matching accepted, published, and succeeded counters and successful backlog samples for both sources. Reports include the fixed Grafana time range.

Each resource sample saves raw process metrics, host PID/CPU/RSS snapshots, and Docker CPU/memory readings for Waybill containers, including Prometheus and Grafana. Process lifetime CPU and peak RSS are recorded after shutdown. These are observations with monitoring enabled, not an instrumentation overhead percentage; that comparison needs an equivalent monitoring-disabled workload. Other applications on this laptop can affect the result.

Reports, request/receipt records, raw metric snapshots, telemetry, and child-process logs are under ignored `logs/load-<run-id>*` paths. Failed runs after publisher startup retain accepted events and their tenant records for inspection. Successful runs remove only their owned records after delivery and queue drain. The runner never purges the queue or uploads S3 fixtures. If a delivery unexpectedly exhausts its retries, the normal backend can still create its dead-letter archive; this runner does not delete such objects.

## Checkpoint status

The local Phase 9 baseline, accepted-pressure comparison, worker confirmation hardening, larger controlled preload, and fault-recovery workload are complete. Busy-tenant tails remain substantial, and the measurements below describe tested workloads rather than a saturation or production-capacity limit. No delivery-table bottleneck was demonstrated, so sharding is deferred.

The authenticated dashboard, GitHub sign-in, tenant authorization, and hosted production-readiness work remain separate checkpoints.

## Runner verification

The first preflight attempt requested the FIFO-only `FifoQueue` attribute on the standard queue. AWS rejected it before any traffic was submitted. The runner now checks the queue name suffix and requests only standard backlog attributes, following the [SQS GetQueueAttributes contract](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_GetQueueAttributes.html).

The first complete submission run accepted and durably delivered all 300 events, with 6.948-second receiver p95 and an 8.404-second maximum. Its final queue assertion failed when an approximate count changed after the first empty reading. That attempt is not a passing baseline. Its records remain available under run ID `478e77b3-117a-4eb7-91e2-f56a2587be2e`. The drain check now waits for repeated empty observations within the original deadline instead of failing on that transition. The workload and latency thresholds are unchanged.

## Passing baseline: 2026-10-27

Run ID: `eb7683eb-ed8c-4332-a3fc-38b4a129bf82`. The workload used the defaults above with no application performance changes between the two submission runs. The runner's queue-drain verification was the only changed path.

| Measurement | Result |
| --- | --- |
| Planned / submitted / accepted | 300 / 300 / 300 |
| HTTP 429 / unexpected request outcomes | 0 / 0 |
| Signed receiver receipts / durable successes | 300 / 300 |
| Pending accepted events | 0 |
| HTTP ingestion p95 | 12 ms |
| Request-to-receiver p95 / maximum | 6,667 ms / 8,056 ms |
| Per-tenant p95, tenants 1 / 2 / 3 | 7,309 / 6,525 / 6,486 ms |
| Accepted request rate | 5.00/second |
| Completed-event throughput through durable completion | 4.65/second |
| Durable completion after submissions ended | 4.522 seconds |
| Repeated empty queue observations after submissions ended | 15.733 seconds |
| Maximum generator schedule lag | 2 ms |
| Duplicate webhook calls / invalid signatures / unexpected payloads | 0 / 0 / 0 |
| Resource samples / collection errors | 8 / 0 |

The overall p95 and each tenant's p95 passed the predeclared 30-second limit. The throughput figures cover different intervals: HTTP submissions lasted 60 seconds, while confirmed durable completion took another 4.522 seconds. Queue drain includes AWS count observations and is not another receiver latency percentile.

Prometheus stored 300 accepted ingestion requests, 300 confirmed outbox publications, and 300 successful terminal-state observations. Both publisher background samplers reported success. Raw counter and backlog snapshots are saved alongside the report.

| Process | Lifetime CPU | Peak RSS from process resource usage |
| --- | --- | --- |
| API | 2.113 seconds | 109.3 MiB |
| Publisher, including backlog sampler | 1.704 seconds | 105.3 MiB |
| Worker | 2.589 seconds | 118.6 MiB |

These totals include startup and the final monitoring checks, not just the 60-second submission interval. Eight Docker samples observed Prometheus at 0.19-1.60% CPU and 141.7-155.2 MiB memory, and Grafana at 0.74-3.72% CPU and 371.8-396.1 MiB memory. These are sampled ranges, not whole-run CPU averages or guaranteed peaks. Grafana was running with provisioning; this did not simulate an operator repeatedly rendering dashboard panels. Database, Redis, generator, and host process observations are also retained in telemetry.

The fixed dashboard window is saved in the JSON report: [Grafana baseline interval](http://127.0.0.1:3300/d/waybill-services?from=1793041498403&to=1793041574136). Local evidence is in `logs/load-eb7683eb-ed8c-4332-a3fc-38b4a129bf82-result.json`, its manifest, telemetry, request/receipt files, raw `.prom` snapshots, and process logs. These files are ignored by Git.

The successful run's temporary processes and owned database records were removed. The earlier nonpassing run's 300 successful records remain for inspection. No queue purge or S3 fixture upload was performed.

### What this establishes

The pipeline can sustain this specific healthy-receiver workload with all instrumentation and collection enabled. It does not establish saturation throughput, fairness during a larger accepted backlog, slow-receiver isolation, load recovery, or monitoring-disabled overhead. There is no measured delivery-table bottleneck here, so there is no basis for sharding. The next checkpoint is higher accepted pressure with a controlled slow receiver and more tenant counts.

## Validation

`bun run check:backend` passed all shared, API, worker, and script TypeScript checks. `bun run test:backend` passed 95 tests with four opt-in database suites skipped. This includes six load-report tests covering missing deliveries, uncertain requests, generator saturation, individual tenant latency, cross-tenant outcomes, duplicate identities, and duplicate webhook calls. The live baseline separately exercised the real API, primary database, Redis, publisher, SQS queue, worker, signed receiver, and monitoring. Replica load and recovery are still pending.

The final read-only audit found zero unpublished outbox rows and zero visible, in-flight, or delayed messages in the queue. No events remained for the successful run. All 300 events from the preserved nonpassing run had durable `SUCCEEDED` outcomes. `git diff --check` passed.

## Sustained busy/quiet workload

The next comparison uses `bun run test:load:pressure`. It declares 120 seconds at 15 requests/second: one busy tenant at 10/second and five quiet tenants at 1/second each. The expected volumes are 1,200 busy and 600 quiet events. Every request must be accepted. Ingestion and delivery budgets remain 20/10 and 10/10 respectively; the higher offered load does not bypass token buckets.

The signed receiver delays only the busy tenant's successful responses by 100 ms. Quiet responses have no added delay. All tenants still share the configured worker destination and queue. This tests interference from slow calls on the shared worker; it does not add per-tenant endpoint routing. Payload data remains 1,024 bytes and maximum HTTP concurrency remains 20.

Quiet tenants retain the 30-second p95 and 90-second maximum limits. The busy tenant has separately declared 600-second p95 and 900-second maximum limits. Its completion time is reported alongside quiet latency. These budgets are fixed before the run and are not inferred from the measured result. The default wait for final outcomes and then queue drain is 900 seconds each.

Every quiet tenant must have at least three accepted requests submitted while at least 100 already-accepted busy events are still awaiting their first signed receiver receipt. This overlap is measured from confirmed 201 responses and the receiver's event IDs. Rejected or uncertain requests do not count as accepted backlog. A run with no meaningful busy pressure cannot pass the fairness check just because quiet deliveries are quick. This is a sustained-arrival workload, not the separately controlled worker-start preload used in Phase 5.

`LOAD_BUSY_RATE`, `LOAD_BUSY_RECEIVER_DELAY_MS`, `LOAD_BUSY_P95_MS`, `LOAD_BUSY_MAX_MS`, and `LOAD_MIN_BUSY_PENDING` configure this profile. `LOAD_RATE` must match the busy rate plus one request/second for each quiet tenant. The runner keeps its baseline profile and its existing failure-preservation behavior.

### Before-change result

Run `4c0a4bfc-e2ce-4aff-ae61-efd74faceb0f` submitted, accepted, signed, and durably completed all 1,800 events without rejection, invalid signatures, or duplicate webhook calls. The maximum observed accepted busy work awaiting receipt was 1,015 events. Each quiet tenant submitted 109 of its 120 requests while at least 100 accepted busy events remained outstanding.

The run failed its quiet latency criterion. Per-tenant quiet p95 was 66.128, 69.283, 66.695, 68.068, and 69.864 seconds. The busy tenant's p95 was 521.306 seconds, maximum 678.269 seconds, and completion from its first submission was 719.103 seconds. The final durable outcome was confirmed 599.322 seconds after submissions ended. The full queue drained. Records are retained for this nonpassing run.

The worker repeatedly reached its ten-message per-tenant turn limit and hid excess reservations for 30 seconds. This delay is separate from retry backoff, circuit cooldown, and token-bucket refill. The late drain had long gaps between small groups even though CPU use was low. Those observations identify the turn-deferral policy as a candidate for the first change; they do not rule out other network or database costs.

### Rejected visibility-delay experiment

The candidate changes only the excess tenant-turn visibility delay from 30 seconds to 1 second. Selection remains capped at ten messages per tenant per receive cycle. Active/buffered message visibility stays at 30 seconds with existing renewal. Deliberately deferred reservations are still released before the visibility update, failed or missing batch confirmations remain errors, and HTTP delivery and circuit-state writes remain sequential. Retry, circuit, and rate-limit delays are unchanged.

The comparison repeats the same pressure profile, receiver delays, token budgets, traffic volumes, latency thresholds, and monitoring setup. Queue operations and confirmed deferrals must be assessed along with latency: a shorter yield could cause more receives or visibility changes even if delivery improves. A copy of the before-change worker source is retained beside its ignored local report.

Run `e27d4248-214f-40ca-afcd-a4e4e2eaa7e5` tested the 1-second visibility delay. All 1,800 events arrived, but quiet p95 still ranged from 57.824 to 74.861 seconds and the busy tenant completed in 692.907 seconds. This did not meet the quiet criterion and did not establish a useful improvement over the 719.103-second busy completion in the first run. The 30-second delay was restored. The candidate's records, metrics, and loaded worker source are retained locally.

### Confirmation pipeline comparison

The next candidate addresses the confirmation barrier between receive batches. Previously, `processDeliveryBatch` waited for every SQS delete in its response before the worker could process the next already-received response. Overlap existed within a response, but not across responses. This could leave the delivery loop waiting on delete calls even when buffered work was ready.

The worker now shares a queue of at most ten pending delete confirmations across one bounded receive cycle. HTTP calls, circuit updates, and durable delivery writes remain sequential. When a delete is slow, the next receive response can begin until the shared confirmation bound is reached. The cycle drains the confirmations before deferring excess tenant selections or starting another cycle. Delete failures are reported against their messages, and successful database state still precedes queue deletion. A completed message can be acknowledged on redelivery without another webhook call.

The original 30-second tenant-turn deferral is retained, so this comparison against the original failing run changes confirmation scheduling only. The same six-tenant pressure profile and all pass/fail limits are reused.

### Passing confirmation comparison: 2026-10-27

Run `2e79084b-2eea-42b6-8553-8363c604c911` passed the unchanged pressure profile. The saved configurations of all three runs were identical. Each run used fresh tenant IDs with the same logical roles and rates. The original and rejected runs' completed records were retained, so this is a local paired comparison, not an identical database snapshot or a production latency guarantee.

| Measurement | Original worker | Shared confirmations |
| --- | --- | --- |
| Accepted / signed receipts / durable successes | 1,800 / 1,800 / 1,800 | 1,800 / 1,800 / 1,800 |
| Rejected / uncertain requests / pending work | 0 / 0 / 0 | 0 / 0 / 0 |
| Worst quiet-tenant p95 | 69.864 seconds | 8.468 seconds |
| Worst quiet-tenant maximum | 81.017 seconds | 16.342 seconds |
| Busy-tenant p95 | 521.306 seconds | 488.440 seconds |
| Busy-tenant maximum | 678.269 seconds | 670.708 seconds |
| Busy completion from first submission | 719.103 seconds | 679.442 seconds |
| Maximum observed accepted busy work awaiting receipt | 1,015 | 830 |
| Overlapping requests for each quiet tenant | 109 of 120 | 107 of 120 |
| Ingestion HTTP p95 | 10 ms | 10 ms |
| Signed HTTP calls / duplicate calls / invalid signatures | 1,800 / 0 / 0 | 1,800 / 0 / 0 |

All five quiet tenants stayed below the predeclared 30-second p95 limit in the final run: 8.143, 7.891, 7.009, 8.468, and 6.928 seconds. The slow busy receiver still produced substantial accepted backlog. Quieter traffic was not tested only after that backlog had drained.

The main measured improvement is quiet-tenant latency. Busy completion changed by about 40 seconds, while its maximum latency remained over 11 minutes. One paired local run is not enough to claim a general throughput improvement. The remaining tail still needs investigation.

| Successful worker SQS command observations | Original worker | Shared confirmations |
| --- | --- | --- |
| Receive, including empty long polls | 1,211 | 1,204 |
| Delete | 1,800 | 1,800 |
| Change visibility, including renewals | 864 | 688 |
| Confirmed tenant-turn receipt deferrals | 6,358 | 5,379 |

Deferrals count repeated receipt selections, not unique events. The final comparison did not increase these observed command counts. They are SDK-operation observations, not an AWS billing measurement. Both runs published 1,800 events; no additional publishers or workers were added.

The rejected 1-second delay generated 8,757 tenant-turn deferrals and 1,138 successful visibility-change operations, more than the original policy. It also recorded one failed delete that was subsequently recovered without another webhook call. This is another reason to retain the original delay rather than treating a smaller timeout as a sufficient fix.

Worker lifetime CPU was 16.531 seconds before and 16.215 seconds after; reported peak RSS was 157.7 and 144.3 MiB respectively. These include startup and drain. They are observations, not a measured allocator or CPU optimization. The original and final runs retained 63 and 59 resource samples with no collection errors. Prometheus, Grafana, background backlog sampling, and all three process metrics stayed enabled. In the final run, sampled Prometheus CPU ranged from 0.16 to 1.80% and Grafana from 0.66 to 2.73%. Raw process/container memory readings remain in telemetry; Grafana was running, not repeatedly rendering operator dashboard panels.

Evidence is under `logs/load-<run-id>*` for each run. Fixed Grafana windows are in the JSON reports: [original](http://127.0.0.1:3300/d/waybill-services?from=1793042232624&to=1793042959020), [rejected delay](http://127.0.0.1:3300/d/waybill-services?from=1793043052714&to=1793043756755), and [shared confirmations](http://127.0.0.1:3300/d/waybill-services?from=1793043822794&to=1793044511619). These windows cover submissions through observed queue drain.

### Validation after hardening

`bun run check:backend` passed. `bun run test:backend` passed 101 tests with the four opt-in database suites skipped. Added coverage checks the busy/quiet request mix, per-tenant overlap with accepted busy work, unchanged quiet limits, the shared pending-delete cap, cross-batch progress, cycle drain, delete-failure reporting, and visibility batch confirmations. HTTP delivery remains sequential.

The final run's owned services stopped and its temporary database records were removed after successful delivery and repeated empty queue observations. The two nonpassing pressure runs retain 1,800 successful records each for inspection. No queue purge or S3 fixture upload was used. A read-only audit confirmed an empty queue and no unpublished outbox rows.

At this checkpoint, recovery and the controlled preload were still pending. Their completed results are recorded below. The measured confirmation bottleneck did not justify delivery-table sharding.

## Controlled larger preload

`bun run test:load:preload` uses two temporary tenants and the signed receiver. It admits 1,200 busy requests at concurrency 20, then waits for all 1,200 owned outbox rows to be published and at least 1,200 visible queue messages with no in-flight or delayed messages. No delivery worker runs during admission or publication. The evidence is saved before the controlled worker start.

The owned API's ingestion capacity is 1,200 for this profile so admission cannot hide dispatch pressure behind HTTP 429 responses. Its refill remains 10/second; worker delivery capacity/refill remain 10/10. This overrides only the temporary API process and does not change normal ingestion defaults. Both receivers are fast: slow-receiver interference was tested separately in the sustained six-tenant workload.

After worker startup, one quiet request per second continues until every accepted busy event has its first signed receipt, with a minimum of three quiet requests. This stopping rule is declared before execution; the final quiet count is determined by busy completion. Every scheduled probe must be submitted and accepted. At least three probes must overlap 100 or more accepted busy events still awaiting receipt. Quiet p95 remains at most 30 seconds, maximum at most 90 seconds; busy p95 is bounded at 900 seconds and maximum at 1,200 seconds. The receiver and worker must have no receipts before startup. The worker-start, admission, publication-evidence, and completion timestamps are recorded separately.

All accepted work must also have durable successful outcomes. Both process metrics and monitoring remain enabled through queue drain, and failures retain owned work for inspection. This test does not compare its adaptive quiet count with the fixed-duration pressure test as if they were identical workloads.

### Completed preload checkpoint: 2026-10-27

Run `015851c9-3d58-442b-b8a2-0efb90d3c5fa` passed. All 1,200 busy events were accepted, published, and visible before worker startup, with no in-flight/delayed messages or receiver receipts. The run then submitted 404 quiet probes. All 1,604 events reached the signed receiver and durable `SUCCEEDED` state, with no rejected or uncertain requests, invalid signatures, or duplicate calls.

Quiet p95 was 7.232 seconds and maximum was 80.539 seconds, within the declared 30/90-second limits. Of the 404 quiet probes, 325 overlapped at least 100 accepted busy events awaiting receipt. The busy tenant completed in 471.340 seconds from its first submission, including admission and publication before worker startup; busy p95 was 420.600 seconds and maximum was 471.131 seconds. These tails remain material even though p95 passed.

The report, pre-start queue evidence, requests, receipts, metrics, and resource samples are under `logs/load-015851c9-3d58-442b-b8a2-0efb90d3c5fa*`. The queue drained and the successful runner removed its owned records and processes.

### Dashboard prerequisites

The GitHub login/session and tenant-membership backend was implemented after these load checkpoints; see [authentication setup](./AUTHENTICATION.md) for its tests and pending real-provider verification. The load and recovery workloads use development caller-authentication bypass and do not measure the new session-check overhead. Session mode still needs OAuth configuration and a verified real sign-in before public exposure.

## Recovery workload

```bash
bun run test:recovery
```

This check seeds 90 events across three temporary tenants through the database and transactional outbox, then continues HTTP ingestion across those tenants with a 350 ms delay after each response. It is a fault-recovery check, not a fixed-arrival capacity benchmark. The receiver adds 30 ms for background events. Each tenant gets an ingestion capacity of five with one token per second, and a dispatch capacity of two with one token per second. Delivery exhaustion uses three attempts for this fixture; the normal application default is unchanged.

Each fault stage must start with at least ten unfinished background events. The stages cover a transient HTTP failure, exhausted delivery using an existing S3 payload, ten concurrent requests with one replay key, tenant ingestion and dispatch limits, paused replica replay, a stopped replica, API restart, publisher leader crash with standby takeover, and worker crash while it owns buffered messages. The complete run is bounded to 15 minutes.

All owned events must have verified signed calls and the expected durable outcome: the original exhausted event stays dead-lettered and every other event succeeds. A replay key must retain one identity after API restart. Reads must remain tenant-scoped, and a replica outage must not prevent primary writes or delivery. Monitoring must recover and the queue/outbox must drain. Duplicate calls are recorded separately from successful receiver effects. The receiver's deduplication set is only an in-memory fixture, not a production exactly-once guarantee.

The runner saves its manifest before creating work and logs under `logs/recovery-<run-id>*`. It restores the local replica after pause/outage, stops its own processes, and removes only its own database records after a passing run. Work from a failed published run remains for inspection. No queue purge or S3 fixture upload is performed.

## Replica recovery finding: 2026-10-27

The first recovery run, `d296cb33-6bee-42fc-b33d-5675475121fb`, passed transient retry, exhausted delivery, ten concurrent replay requests producing one event, and ingestion/dispatch rate-limit checks. It then timed out reading the probe delivery from the replica. This run failed and is not a passing recovery result.

The primary had the successful delivery, but the replica did not. PostgreSQL reported that WAL segment `000000010000000000000005` had already been removed. The replica process could answer queries and `pg_is_in_recovery()` returned true, so the old container health check incorrectly appeared healthy. There was no persistent replication slot protecting history while the standby was disconnected.

The local setup now creates a physical replication slot, uses it for the base backup and streaming, and sets `max_slot_wal_keep_size` to 256 MB. This bounds retained history; a sufficiently long outage can still invalidate the slot. Setup waits for an active slot-backed streaming connection to replay a captured primary WAL position. Container health also requires an active streaming receiver. The recovery runner checks catch-up before creating traffic.

```bash
bun run setup:replica
bun run setup:replica --reseed
bun run test:replica
```

`--reseed` stops only the replica and moves its old data directory aside before taking a new base backup. The stale copy was retained at `/var/lib/postgresql/data/pgdata.before-reseed-20261027144330` inside the replica volume. The primary and its accepted event records were preserved. Reseeding needs disk space for both copies; retained copies require deliberate cleanup later.

After rebuilding, the replica passed initial catch-up, paused-replay isolation, rejected writes, and resume/catch-up checks. Repeating normal setup also passed. The first run's logs, failed report, and retained records remain available for diagnosis. Its interrupted deliveries were drained separately: 359 events succeeded and the original exhausted event remained dead-lettered. The drain verified repeated empty queue/outbox observations and retained all 360 records; its result is saved alongside the failed run.

References: [PostgreSQL streaming replication and slots](https://www.postgresql.org/docs/16/warm-standby.html), [base backup slot handling](https://www.postgresql.org/docs/16/app-pgbasebackup.html), and [replication slot retention](https://www.postgresql.org/docs/16/view-pg-replication-slots.html).

## Passing recovery run: 2026-10-27

Run `3b3456e4-c06b-4d97-88e3-1fc30f0bbd76` passed after the replication fix. The declared workload and limits were unchanged. The manifest, HTTP requests, signed call counts, process logs, pre-crash/final metric snapshots, and result are under `logs/recovery-3b3456e4-c06b-4d97-88e3-1fc30f0bbd76*`.

| Check | Observed result |
| --- | --- |
| Total owned events | 388 |
| Background events | 90 seeded through the outbox, 284 accepted over HTTP |
| Durable outcomes | 387 succeeded, one intentionally dead-lettered |
| Transient failure | Two calls, then success |
| Exhausted event | Three failed attempts; original failure history retained |
| Replay | Ten concurrent requests returned one event; the same key retained that identity after API restart |
| Ingestion burst | Five accepted, 20 rejected with `Retry-After`; another tenant retained its budget |
| Dispatch limit | Deferred work subsequently succeeded; rate-limit deferral counter increased |
| Replica lag | Primary delivery completed while replica reads stayed frozen; reads caught up after resume |
| Replica outage | Reads returned 503; primary ingestion and delivery continued; reads recovered after restart |
| Publisher leader crash | Standby acquired leadership and published newly accepted work |
| Worker crash | Work continued after restart and all owned events reached the expected outcome |
| Unexpected request outcomes / invalid signatures / unexpected payloads | 0 / 0 / 0 |
| Repeated webhook calls beyond the first | Four, including expected retries and one duplicate successful call |
| Unique successful receiver effects | 387 |
| Final state | Queue/outbox drained, all three monitoring targets healthy, owned processes stopped |

Every fault phase began with outstanding background work: 92, 90, 120, 124, 125, 129, 127, and 133 events respectively. The successful run removed its own temporary database records only after durable outcome and queue-drain checks. The earlier failed run remains preserved.

The duplicate successful call is consistent with at-least-once delivery during a crash window. Receivers must handle repeated event IDs. This test used an in-memory set to count logical effects; it does not establish durable receiver idempotency or exactly-once delivery. Process counters reset during restarts, so the report uses database outcomes for final event accounting rather than adding reset counters as if they were continuous.

Backend types passed, and the backend suite passed 102 tests with four opt-in database tests skipped. The repaired replica also passed the live catch-up, paused-replay, rejected-write, and resume checks. Shell syntax and Compose configuration validation passed. Successful CI for the previously committed backend is recorded in the guide; these uncommitted changes still need their own CI run.

## Phase 9 decision and remaining limits

The reproducible bottleneck was the confirmation barrier between receive batches. Sharing bounded pending confirmations improved quiet-tenant p95 from 69.864 to 8.468 seconds in the unchanged pressure comparison. The larger preload and recovery run completed without losing accepted work. The recovery workload additionally exposed stale replication that the original health check missed; slot-backed streaming, catch-up verification, and explicit reseeding now address that local failure.

There is no evidence that the `deliveries` table is the bottleneck, so no sharding or schema routing was added. The result is scoped to this laptop, local PostgreSQL/Redis/receiver, and the configured real AWS queue and bucket. Busy completion can still take several minutes, including more than eleven minutes in the slow-receiver pressure run. A production latency target, saturation capacity, multiple active delivery workers, a wider receiver-latency distribution, and long-duration failure soak tests remain unmeasured.

Local Phase 9 checkpoints are complete. This does not complete GitHub authentication, tenant ownership enforcement, graceful shutdown/readiness, container release verification, managed replication, or hosted deployment. No website changes, dependency additions, commits, or pushes were made as part of the recovery checkpoint.
