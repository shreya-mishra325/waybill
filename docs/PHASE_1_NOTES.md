# Phase 1 - Ingestion and the outbox

Phase 1 is the write path only. A tenant backend POSTs an event. Waybill records that event and, in the same database transaction, records that it still needs to be published. Nothing is sent to SQS yet.

## What I shipped

- Layered ingest: route, controller, service, repository.
- `POST /events` accepts `{ tenantId, type, payload }` and returns `{ eventId, outboxId, storedIn }`.
- One shared Prisma client with a five-second connect timeout.
- A repeatable `dev-tenant` seed and Bun clients (`bun run post:event`, `bun run post:event:large`).

## Verified

Small payload: `201`, `storedIn: "postgres"`. The JSON sits in `events.payload`. `payloadS3Key` is null. An `outbox` row is created in the same transaction with `published = false`.

Large payload (over 256KB): `201`, `storedIn: "s3"`. `events.payload` is SQL null. `payloadS3Key` is `events/{tenantId}/{eventId}.json`. The object is in S3. The outbox row still exists and is unpublished. The queue never saw the raw blob.

## What I learned

**Business rules stay out of the controller.**
The controller only maps results to HTTP: 201, 400, 404, 500. Size checks, S3, and the transaction live in the service. The repository only inserts rows. When the poller exists, it will reuse the same tables without caring about Express.

**The outbox exists so two facts cannot drift.**
"This event was accepted" and "this event will be published" are written in `prisma.$transaction`. If the process dies after the event row and before an outbox row, the event would sit in the database forever and never leave. One transaction makes that impossible. Dual writes (DB then queue, or queue then DB) cannot give you that guarantee without extra machinery.

**Claim-check is about the queue limit, not about Postgres.**
SQS caps a message at 256KB. A large payload is uploaded to S3 before the transaction opens. The row stores a pointer (`payloadS3Key`) instead of the JSON. The future SQS message will carry that pointer, never the oversized body. Holding a DB transaction open across S3 would keep a connection busy for a network round trip. Uploading first keeps the transaction short. If S3 succeeds and the transaction fails, an orphan object can remain. That is leftover storage, not a lost event. Deleting orphans is cleanup. The ingest invariant is "no event without an outbox row."

**Measure bytes, not string length.**
`JSON.stringify` plus `TextEncoder` gives UTF-8 byte size, which is what SQS counts. Character length would under-count multi-byte JSON and could push a "small" message over the cap.

**Express rejects large bodies before your handler runs.**
The default JSON limit is 100KB. I raised it to 2MB so a >256KB test can reach the service. Without that, the claim-check branch would never execute.

**Generate the event id before insert.**
The S3 key is `events/{tenantId}/{eventId}.json`. The id is created in the service so the object key and the primary key match. The repository accepts that id instead of letting the database invent one after the upload.

**Windows shells are a bad JSON client.**
PowerShell turned escaped quotes into literal backslashes, so the API saw invalid JSON. A Bun script posts `JSON.stringify(...)` and avoids that class of error.

**Host ports can be reserved even when they look free.**
After moving off local Postgres on 5432, Docker later failed to bind 55432. Windows Hyper-V had excluded 55378-55477. Prisma then could not reach the database even though Redis and the API process were up. The container now publishes 15432, which is outside that range. Same volume, same data. The lesson is to treat "port in use / access denied" as a host reservation problem, not only as "another process is listening."

## Checkpoint

| Check | Result |
|---|---|
| `bun run seed:tenant` | Tenant `dev-tenant` created |
| `POST /events` small payload | `201`, `storedIn: "postgres"`, event + outbox in one transaction |
| `POST /events` payload > 256KB | `201`, `storedIn: "s3"`, `payload` null, `payloadS3Key` set |

Next is Phase 2: an outbox poller publishes unpublished rows to SQS, and a worker long-polls the queue and POSTs to a test receiver. No retries yet.
