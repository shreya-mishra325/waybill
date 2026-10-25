# Waybill

A reliable, multi-tenant webhook delivery platform, built to learn distributed
systems fundamentals through practice. A waybill is the document
that travels with a shipment and proves it arrived; this does the same for
HTTP events.

Full project guide (architecture, phases, checkpoints, production readiness):
see `docs/project-guide.md`. Phase notes: `docs/PHASE_0_NOTES.md`,
`docs/PHASE_1_NOTES.md`, `docs/PHASE_2_NOTES.md`, `docs/PHASE_3_NOTES.md`, `docs/PHASE_4_NOTES.md`.
Architecture and planned repository layout:
[`docs/waybill-architecture.md`](docs/waybill-architecture.md)

## Quick start

Requires [Bun](https://bun.sh) and a free-tier AWS account (SQS + S3).

```bash
cp .env.example .env

docker-compose up -d postgres redis     
bun install
bun run prisma:migrate
bun run dev:api       
bun run dev:worker    
```

`GET http://localhost:3000/health` should return `{ "status": "ok" }`.

## Local read replica

After the primary database is initialized:

```bash
bun run setup:replica
```

Set `READ_REPLICA_DATABASE_URL` in `.env` to the local connection shown by setup, then verify replication:

```bash
bun run test:replica
```

The replica uses its own Docker volume and port 15433. Setup details and the replication-lag test are in [Phase 7 notes](docs/PHASE_7_NOTES.md).

## Repo layout

```
packages/
  api/
  worker/
  shared/
docs/
```

Runtime: **Bun**. Queue: **Amazon SQS** (real AWS, free tier). Large payloads
and audit archive: **Amazon S3**. Cache/rate-limit/circuit-breaker state: **Redis**
(local, via docker-compose). Redis is not used as the queue.
