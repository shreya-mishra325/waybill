# Waybill

A reliable, multi-tenant webhook delivery platform, built to learn distributed
systems fundamentals by building — not reading. A waybill is the document
that travels with a shipment and proves it arrived; this does the same for
HTTP events.

Full project guide (architecture, phases, checkpoints, production readiness):
see `docs/project-guide.md`. Architecture diagram: `docs/waybill-architecture.pdf`
(dark) and `docs/waybill-architecture-light.pdf` (light).

## Quick start

Requires [Bun](https://bun.sh) and a free-tier AWS account (SQS + S3).

```bash
cp .env.example .env
# fill in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / SQS_QUEUE_URL / S3_BUCKET_NAME in .env
docker-compose up -d postgres redis     # Postgres + Redis only — SQS/S3 are real AWS
bun install
bun run prisma:migrate
bun run dev:api      # starts the ingestion API on :3000
bun run dev:worker    # starts the delivery worker
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
