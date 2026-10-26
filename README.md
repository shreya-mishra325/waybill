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

## Backend checks

```bash
bun run prisma:generate
bun run prisma:validate
bun run check:backend
bun run test:backend
```

The default backend tests skip the four opt-in database suites. GitHub Actions runs those suites sequentially against a fresh primary and physical replica on its runner, without an API server, publisher, or queue consumer. The backlog suite also verifies pending-row counts and the database lock timeout. Outbox sends are mocked; live SQS and S3 smoke tests remain separate.

## Local service monitoring

Requires Docker Desktop on this development setup:

```bash
bun run monitoring:up
```

Grafana runs at [127.0.0.1:3300](http://127.0.0.1:3300/d/waybill-services), and Prometheus at [127.0.0.1:9090](http://127.0.0.1:9090). Login credentials are generated once in the ignored `.env.monitoring` file. Start each backend process with `METRICS_ENABLED=true` to populate its target; monitoring does not start the application services.

```bash
bun run monitoring:check
bun run monitoring:down
```

Stopping monitoring retains its named volumes. The controlled fixture check is `bun run test:monitoring`; it requires ports 9100-9102 to be free and does not use application databases or AWS. Configuration, metric meanings, and limitations are in [Phase 8 notes](docs/PHASE_8_NOTES.md).

The remaining Phase 8 checks are available as separate commands:

```bash
bun run test:monitoring:flow
bun run test:monitoring:overhead
```

The flow check sends real development SQS traffic and reuses an existing S3 archive. The overhead probe writes temporary local ingestion records while holding the publisher lock and makes no AWS calls. Both own their temporary application processes and require no competing publisher. Preconditions, cleanup behavior, measured scope, and results are in the Phase 8 notes.

## Sustained backend load

```bash
bun run test:load --help
bun run test:load
bun run test:load:pressure
```

Requires the local primary and Redis, running service monitoring, an empty development SQS queue and outbox, and no competing publisher or worker. The runner owns its API, publisher, worker, receiver, and test tenants. The default workload sends 300 events over 60 seconds across three tenants, verifies signed deliveries and durable outcomes, and records service/container resources. Failed runs preserve accepted work; reports stay under ignored `logs/`. The pressure profile sends 1,200 busy-tenant and 600 quiet-tenant events, with a delayed busy receiver. Configuration, pass criteria, and results are in [Phase 9 notes](docs/PHASE_9_NOTES.md).

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
