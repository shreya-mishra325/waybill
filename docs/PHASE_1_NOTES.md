# Phase 1 — Ingestion and the outbox (in progress)

Phase 1 is the write path only. A tenant’s backend POSTs an event. Waybill must record that event and, in the same database transaction, record that it still needs to be published. Nothing is sent to SQS yet.

## What I shipped

- Layered ingest: route → controller → service → repository.
- `POST /events` accepts `{ tenantId, type, payload }` and returns `{ eventId, outboxId, storedIn }`.
- One shared Prisma client with a five-second connect timeout.
- A repeatable `dev-tenant` seed and a Bun client (`bun run post:event`) so I can ingest without fighting shell quoting.

Verified: a small payload returns `201` and `storedIn: "postgres"`. The matching `events` and `outbox` rows are written together.

Not verified yet: a payload over 256KB (claim-check to S3). That is the remaining Phase 1 checkpoint.

## What I learned

**Business rules stay out of the controller.**  
The controller only maps results to HTTP: 201, 400, 404, 500. Size checks, S3, and the transaction live in the service. The repository only inserts rows. That split is boring on purpose — when the poller exists, it will reuse the same tables without caring about Express.

**The outbox exists so two facts cannot drift.**  
“This event was accepted” and “this event will be published” are written in `prisma.$transaction`. If the process dies after the event row and before an outbox row, the event would sit in the database forever and never leave. One transaction makes that impossible. The poller (Phase 2) will read unpublished outbox rows; it is not part of this phase.

**Claim-check is about the queue limit, not about Postgres.**  
SQS caps a message at 256KB. A large payload is uploaded to S3 *before* the transaction opens, then the row stores `payloadS3Key` and leaves `payload` null. Holding a DB transaction open across a network upload would lock the row for the duration of S3. Uploading first keeps the transaction short. If S3 succeeds and the transaction fails, an orphan object can remain — acceptable for now; deleting it is cleanup, not the ingest invariant.

**Measure bytes, not string length.**  
`JSON.stringify(payload)` then `TextEncoder` gives UTF-8 byte size, which is what SQS counts. Character length would under-count multi-byte JSON.

**Express rejects large bodies before your handler runs.**  
The default JSON limit is 100KB. I raised it to 2MB so a >256KB test can reach the service. Otherwise the claim-check branch would never execute.

**Generate the event id before insert.**  
The S3 key is `events/{tenantId}/{eventId}.json`. The id is created in the service so the object key and the primary key match. The repository accepts that id instead of letting the database invent one after the upload.

**Windows shells are a bad JSON client.**  
PowerShell turned `\"` into literal backslashes, so the API saw invalid JSON (`Unrecognized token '\'`). A small Bun script posts `JSON.stringify(...)` and avoids that class of error.

## Checkpoint

| Check | Result |
|---|---|
| `bun run seed:tenant` | Tenant `dev-tenant` created |
| `POST /events` small payload | `201`, `storedIn: "postgres"`, event + outbox in one transaction |
| `POST /events` payload > 256KB | still to do |

Next: post a payload over 256KB and confirm the row has `payload` null and `payloadS3Key` set, with the object in S3.
