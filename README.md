# Waybill

A reliable, multi-tenant webhook delivery platform, built to learn distributed
systems fundamentals by building — not reading. A waybill is the document
that travels with a shipment and proves it arrived; this does the same for
HTTP events.

Full project guide (architecture, phases, checkpoints, production readiness):
see `docs/project-guide.md`. Phase notes: `docs/PHASE_0_NOTES.md`,
`docs/PHASE_1_NOTES.md`, `docs/PHASE_2_NOTES.md`, `docs/PHASE_4_NOTES.md`.
Architecture diagram: `docs/waybill-architecture.pdf`

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

Check `GET http://localhost:3000/health` — you should get `{ "status": "ok" }`.

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
(local, via docker-compose — it is not the queue).
