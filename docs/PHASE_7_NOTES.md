# Phase 7 - Observability and replay

Dashboard queries need their own database connection so reading delivery history does not add load to the write database. I started with a local PostgreSQL physical replica to test read routing and replication lag before adding the history API.

The local replica uses Docker and a separate data volume. A managed replica is still part of deployment work; this setup does not complete the hosted infrastructure requirement.

## Local databases

| Connection | Host port | Role |
| --- | --- | --- |
| Primary | 15432 | Ingestion, delivery updates, and replay writes |
| Replica | 15433 | Dashboard reads through `waybill_reader` |

`docker-compose.replica.yml` adds the replica without changing the primary data volume. The service is optional and binds its port to localhost. It uses the same PostgreSQL 16 image as the primary.

`bun run setup:replica` starts the existing primary, creates dedicated local replication and reader accounts if absent, grants table reads, and adds a password-authenticated replication rule to the primary's `pg_hba.conf`. PostgreSQL reloads that rule without restarting. The setup leaves the API and worker stopped if they were not already running.

On the first start, `pg_basebackup -R -X stream` copies the cluster and writes the standby configuration. Later starts reuse the replica volume. The startup script refuses a nonempty directory without a complete base backup or a directory without `standby.signal`, so initialization cannot silently replace existing files.

The replication account has replication permission. The dashboard account has database connect, schema usage, and table SELECT privileges. Default table privileges cover future tables created by the existing `webhook` migration role. The fixed passwords in this Docker setup are for local development only.

## Running it

From the repository root:

```bash
bun run setup:replica
```

Set the local connection in `.env`:

```dotenv
READ_REPLICA_DATABASE_URL=postgresql://waybill_reader:local-reader-only@127.0.0.1:15433/webhook_platform
```

The hostname is different for an API running inside Docker: use `postgres-replica:5432` instead of `127.0.0.1:15433`. `setup:replica` prints the host connection for Bun processes running on the laptop.

To stop only the replica:

```bash
docker compose -f docker-compose.yml -f docker-compose.replica.yml stop postgres-replica
```

Running `bun run setup:replica` starts it again. Data stays in the named volumes. Do not use `docker compose down -v` as a reset command because it can remove database volumes.

## Replica reads

`withReplicaRead` lazily creates a separate Prisma pool from `READ_REPLICA_DATABASE_URL`. Existing writes continue through the primary client. Importing the shared package does not require a replica URL; invoking the read helper does. Missing configuration or a replica connection failure does not fall back to the primary.

Each call starts a read-only transaction and checks `pg_is_in_recovery()` before executing its query callback. A primary, including a promoted standby, is rejected. A read-only account on the primary is not a substitute for a physical replica. The callback must use the supplied transaction client.

Connection and pool waits are capped at five seconds; socket and transaction execution are capped at ten seconds. `disconnectReadReplica` closes the read pool during shutdown.

## Proving the reads use the replica

```bash
bun run test:replica
```

The script is restricted to the local Waybill database and ports. It creates one temporary tenant on the primary and waits for it to appear through the replica helper. It then pauses WAL replay on the replica and changes that tenant's name on the primary.

The primary returns the updated value while the replica helper still returns the old value. That is stronger evidence of routing than checking that two connection URLs differ. A write through the replica helper is rejected. After replay resumes, the updated value appears on the replica.

The script resumes replay and deletes its tenant in cleanup, then waits for the deletion to replicate. A pre-existing replay pause causes the test to refuse to run. SIGINT and SIGTERM request cleanup; a forced kill cannot run cleanup. If a test process is forcibly killed during the pause, resume replay manually:

```bash
docker compose -f docker-compose.yml -f docker-compose.replica.yml exec -T postgres-replica psql -U webhook -d webhook_platform -c 'SELECT pg_wal_replay_resume()'
```

## Results: 2026-10-25

- The replica became healthy, and initial primary writes appeared through the read helper.
- While replay was paused, the primary returned the new tenant name and the replica returned the previous name.
- The replica rejected a table update.
- After replay resumed, the replica caught up; the temporary tenant was deleted from both databases.
- Repeating setup reused the running replica and its data volume.
- The existing primary-rejection check refused to run its callback against the main database.
- `bun test`: 37 passed, one opt-in PostgreSQL test skipped. API, worker, shared, and script TypeScript checks passed.

## Delivery history API

`GET /tenants/:tenantId/deliveries` reads delivery rows from the replica. The route calls a controller, the service validates input and prepares the page, and the repository runs the query through `withReplicaRead`. No primary lookup is needed for a history request.

```bash
curl 'http://127.0.0.1:3000/tenants/<tenant-id>/deliveries?status=FAILED&limit=20'
```

| Parameter | Behavior |
| --- | --- |
| `status` | Optional: `PENDING`, `IN_FLIGHT`, `SUCCEEDED`, `FAILED`, or `DEAD_LETTERED` |
| `limit` | Defaults to 50; accepts integers from 1 to 100 |
| `cursor` | Opaque next-page value returned by the previous response |

The response has `items` and `nextCursor`. Each item includes delivery and event IDs, tenant ID, event type, target URL, status, attempt count, creation and attempt timestamps, next retry time, and last error. It excludes event payloads and tenant signing secrets.

Rows are ordered by `createdAt DESC, id DESC`. The ID breaks ties when records share a timestamp. The repository fetches one extra row to decide whether another page exists. The cursor stores the last returned timestamp and ID, along with the tenant and status filter; changing tenant or filter requires a fresh page request.

Pagination does not depend on the boundary row still existing. It is not a frozen snapshot across requests: a delivery can change status between pages, and replication can advance between requests. An empty page can mean no matching records, an unknown tenant, or data that has not reached the replica yet. The endpoint returns current delivery rows, not an immutable log of individual attempts.

Invalid tenant IDs, query parameters, or cursors return 400. A failed replica read or a connection to a primary returns 503 with a generic error. The controller logs the underlying failure; the response does not expose connection details. The current API has no caller authentication. Tenant filtering limits each query's records, but a tenant ID in the URL is not proof that a caller owns that tenant.

## Delivery history tests: 2026-10-25

```bash
RUN_REPLICA_TESTS=1 bun test
```

The opt-in integration test is restricted to the local primary and replica. It creates isolated tenants, events, and deliveries without outbox messages, so it does not publish anything to AWS. It removes those fixtures and resumes replay in cleanup. Run it without another test controlling replica replay.

The HTTP test verified tenant filtering, status filtering, pagination across identical timestamps, the final page, invalid inputs, cursor context checks, and exclusion of private payload and secret fields. A paused-replay test changed a failed delivery to succeeded on the primary: the endpoint continued showing it as failed until the replica caught up. Reconfiguring the read helper with the primary URL returned 503 instead of serving primary data.

The full run passed 41 tests, with the unrelated opt-in outbox test skipped. API, worker, shared, and script TypeScript checks passed. Without `RUN_REPLICA_TESTS=1`, the replica HTTP test is skipped.

## Delivery summary API

`GET /tenants/:tenantId/deliveries/summary` returns counts for all five delivery states, the total count, the number of terminal deliveries, and `successRatePercent`. It accepts a tenant UUID and no query parameters. The counts cover all retained delivery rows for that tenant, rather than a time window or the current history page.

```bash
curl 'http://127.0.0.1:3000/tenants/<tenant-id>/deliveries/summary'
```

For two successful deliveries, one dead-lettered delivery, and one delivery in each unfinished state:

```json
{
  "total": 6,
  "counts": {
    "PENDING": 1,
    "IN_FLIGHT": 1,
    "SUCCEEDED": 2,
    "FAILED": 1,
    "DEAD_LETTERED": 1
  },
  "completed": 3,
  "successRatePercent": 66.67
}
```

The denominator is `SUCCEEDED + DEAD_LETTERED`. A `FAILED` row can still be waiting for a retry, so treating it as a final failure would mix temporary state with terminal outcomes. `PENDING`, `IN_FLIGHT`, and `FAILED` remain visible in the counts but do not affect this rate. With no terminal outcomes, the rate is `null`, not zero or 100. Percentages are rounded to two decimal places.

The repository groups rows by status inside one replica read transaction. Counts and their derived totals come from that single aggregation rather than separate queries that could see different data. The result measures current delivery outcomes, not successful individual attempts. An empty or unknown tenant returns zero counts and a null rate, subject to replication lag.

The summary follows the same validation and failure behavior as history: malformed input returns 400, and an unavailable replica or a primary connection returns a generic 503. Tenant filtering still does not provide caller authentication.

## Summary tests: 2026-10-25

Unit tests covered empty results, every status count, unfinished-only workloads, rounding, all-successful outcomes, and all-dead-lettered outcomes. The local HTTP test checked tenant isolation, a tenant with no deliveries, unsupported query parameters, and invalid tenant IDs.

With two successful and one dead-lettered delivery, the endpoint returned 66.67 percent. The test paused replay and changed a failed row to succeeded on the primary. The summary stayed at 66.67 until replay resumed, then reached 75 percent. A deliberate primary connection returned 503 for the summary as well as history.

`RUN_REPLICA_TESTS=1 bun test` passed 45 tests, with one unrelated outbox test skipped. All package and script TypeScript checks passed. Test fixtures were removed and replica replay resumed.

## Dead-letter browsing and archived payloads

The worker writes failure metadata to `dead_letters` and stores the payload JSON in S3. Small payloads are archived under `dead-letters/{eventId}.json`; S3-backed events retain their existing `events/{tenantId}/{eventId}.json` pointer. The archive contains the payload, not the signed HTTP envelope.

```text
GET /tenants/:tenantId/dead-letters
GET /tenants/:tenantId/dead-letters/:deadLetterId/payload
```

The list reads through the replica and returns record, event, delivery, and tenant IDs; destination; last error; attempt count; creation time; and event type. It excludes payload contents and S3 keys. Pages default to 50 records, allow at most 100, and use descending creation time and ID. Cursors are tied to the tenant and dead-letter resource, so a delivery-history cursor cannot be reused here.

This lists archive records, independently of the delivery's current status. The record is useful as failure history even if a later replay changes the delivery outcome. Replication lag can temporarily hide a newly created archive record.

The payload endpoint first looks up the dead-letter ID together with its tenant ID on the replica. Only that stored key is passed to S3; the caller cannot provide a key or bucket. The response includes `deadLetterId`, `tenantId`, `eventId`, and the parsed `payload`, with `Cache-Control: no-store`.

The S3 operation has one 15-second deadline covering the initial request and body download. The reader enforces a 4 MiB inspection limit against both the advertised content length and actual received bytes. It also cancels unfinished streams and rejects invalid UTF-8 or JSON. This limit applies to inspection through the API, not to archive retention.

| Condition | Response |
| --- | --- |
| Invalid IDs, query parameters, or cursor | 400 |
| No matching record for that tenant | 404 |
| S3 reports `NoSuchKey` | 410 |
| Archive exceeds the inspection limit or is not valid JSON | 502 |
| Replica failure, S3 access failure, or read timeout | 503 |

A missing S3 object can produce AccessDenied instead of NoSuchKey when the credentials lack bucket-list permission. That ambiguous response remains 503 rather than being presented as a confirmed deletion. See the [S3 GetObject permission behavior](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).

## Archive tests: 2026-10-25

`RUN_REPLICA_TESTS=1 bun test` passed 52 tests, with the unrelated outbox test skipped. All package and script TypeScript checks passed. The tests covered tenant filtering, tied timestamps and pagination, incompatible cursors, missing records, caller-supplied key rejection, stale replica metadata, and safe replica-failure responses.

Streaming tests covered Unicode split across chunks, null payloads, empty or malformed JSON, invalid UTF-8, oversized advertised and actual lengths, and cancellation of a stalled body at the deadline. These checks do not require AWS writes.

The optional upload-based S3 test reached cleanup, where DeleteObject returned AccessDenied. Two test objects remained. Their keys are recorded locally in `logs/archive-cleanup-2026-10-25.json`; this file is ignored by Git. AWS permissions were left unchanged. Future upload-based tests check delete permission before uploading and write an object manifest under `logs/` before creating objects.

A separate read-only smoke test used an existing development S3 payload through the real HTTP endpoint. It returned 200 with 262,155 payload bytes and `Cache-Control: no-store`. A lookup of a nonexistent key returned 410. The source object was unchanged, and the temporary database records were removed.

The optional upload test requires both local replica access and permission to put, get, and delete its test objects:

```bash
RUN_REPLICA_TESTS=1 RUN_ARCHIVE_TESTS=1 bun test
```

The current credentials do not pass that cleanup-permission check. The read API itself only needs GetObject; changing IAM is separate from implementing archive reads. The tests do not replay messages or publish to SQS.

## Manual replay

```text
POST /tenants/:tenantId/dead-letters/:deadLetterId/replay
Idempotency-Key: <UUID for this replay request>
```

The body is empty or `{}`. The endpoint does not accept replacement payloads, destinations, or force flags. It reads the source delivery and prior replay requests from the primary because replica lag cannot be allowed to decide whether a new command is eligible.

A replay creates a new event ID, rather than resetting the old delivery. The new event retains the type and points to the archived payload. The worker therefore creates a fresh delivery with its normal retry budget, while the original failed delivery keeps its status, error, and attempt count. The signed HTTP envelope contains the new event ID; the original event ID is available in the replay response and audit relation.

This identity choice also avoids treating a stale SQS message for the original dead-lettered delivery as the replay. The original remains complete, while the new event follows the existing outbox, tenant grouping, rate-limit, circuit, signing, and retry path.

The `replays` table links the source dead-letter record, new event, tenant, request key, and creation time. A transaction creates the new event, its outbox row, and this audit record together. There is no direct SQS send in the POST handler. An API crash after commit leaves the pending outbox row for the publisher to send later. SQS publication remains at least once.

Uniqueness applies to both `(tenantId, idempotencyKey)` and the source dead-letter ID. Repeating the same key for the same source returns the stored response without another S3 read or event creation. Reusing that key for another source returns 409. A different key for an already replayed source also returns 409. Each dead-letter record has at most one replay; if the replay exhausts its own retries, its new dead-letter record can be replayed separately.

Before creating a command, the service checks that the source delivery is `DEAD_LETTERED`, its destination matches the API's configured `RECEIVER_URL`, and the archived payload can be read as JSON. Archive reads use the existing 15-second and 4 MiB limits. The transaction rechecks the source state, destination, and archive pointer before writing. Conflicting concurrent inserts roll back their new event and outbox; the service resolves a repeated key against the committed record.

API and worker processes still need the same `RECEIVER_URL`. Per-tenant destination configuration remains separate work. A successful archive check does not reserve the S3 object: it can disappear before the worker reads it, in which case normal bounded retry handling applies.

| Condition | Response |
| --- | --- |
| Command accepted, including repetition of the same command | 202 |
| Invalid IDs, missing UUID request key, or unexpected fields | 400 |
| No source record for that tenant | 404 |
| Ineligible source, destination mismatch, or conflicting replay | 409 |
| Missing archived payload | 410 |
| Invalid or oversized archive | 502 |
| Primary database or S3 unavailable | 503 |

The response includes `replayId`, `deadLetterId`, `originalEventId`, the new `eventId`, and `createdAt`. A 202 response confirms the durable command, not successful delivery. Follow the new event in delivery history for the outcome. Dead-letter listings also include the replay ID, event ID, and creation time when a replay exists. The request key is not exposed in those listings.

The API still has no caller authentication; the tenant filter is not an authorization mechanism. Replay auditing records the command and tenant, not a verified human operator.

## Replay validation: 2026-10-25

Migration `20261025010000_replays` adds the audit table without modifying existing delivery or outbox records. Historical migrations are unchanged. Prisma remains at 5.22.0.

For another local checkout, apply the migration and regenerate the client before starting the API:

```bash
bunx prisma@5.22.0 migrate deploy --schema packages/shared/prisma/schema.prisma
bun run prisma:generate
```

The database test raced concurrent requests, checked one replay and one outbox row, verified rollback without orphan events, rejected another tenant, and confirmed that the original failure and retry count were unchanged. It holds the publisher's advisory lock while its temporary pending rows exist, so the publisher must be stopped before running it.

```bash
RUN_DB_TESTS=1 RUN_REPLICA_TESTS=1 RUN_REPLAY_TESTS=1 bun test
```

All 55 tests passed with the database, replica, and replay tests enabled. All package and script TypeScript checks passed.

The repeatable end-to-end test uses the real queue and an existing S3 payload:

```bash
bun run test:replay
```

It requires an empty development queue and outbox, a configured development tenant with an existing S3-backed event, and no active publisher or other queue consumers. It owns its API, publisher, worker, and verifying receiver. The test uses API port 3107 by default; `REPLAY_TEST_API_PORT` can change that port.

Two simultaneous POSTs returned the same new event ID. The outbox row remained pending before publisher startup. The test stopped the API after commit, started the publisher and worker, and received the signed replay successfully on its first attempt. The original delivery still had eight attempts and `DEAD_LETTERED` status. After restarting the API, the original request key still returned the same replay.

The queue drained, temporary processes stopped, and owned database records were removed. No S3 objects were uploaded, changed, or deleted. If a run fails after publication starts, it preserves accepted work for inspection rather than deleting database records behind a queued message. Run details and process output are written under ignored `logs/` files.

## What I learned

A replica can be healthy and still return older data. A delivery may already be marked successful on the primary while a dashboard query briefly shows the previous state. The dashboard needs to account for that delay; replay decisions must use authoritative primary state.

Read-only permissions and standby identity are separate checks. The reader account limits table access, while `pg_is_in_recovery()` proves the connection reached a physical standby. The paused-replay test demonstrates the routing with an observable difference in data.

This local setup has no replication slot or extra WAL-retention configuration. If the replica stays offline until the primary removes required WAL, it may need a new base backup. The scripts deliberately do not erase and rebuild its volume automatically. This is a learning setup, not a high-availability deployment or an automatic failover system.

Delivery history, status summaries, dead-letter browsing, archived payload retrieval, and manual replay are implemented. This completes the local Phase 7 backend. Metrics, load testing, and backend hardening come next; the tenant dashboard will be built and connected afterward. Hosted primary/replica selection remains deployment work.

References: [PostgreSQL standby setup](https://www.postgresql.org/docs/16/warm-standby.html), [pg_basebackup](https://www.postgresql.org/docs/16/app-pgbasebackup.html), [recovery functions](https://www.postgresql.org/docs/16/functions-admin.html), [read-only transactions](https://www.postgresql.org/docs/16/sql-set-transaction.html).
