# Phase 0 — Local platform and AWS wiring

Phase 0 was about getting a boring, honest foundation in place: two local services, one empty API, a real AWS queue and bucket, and a database schema I can migrate. Nothing is delivering webhooks yet.

## What I shipped

- A Bun workspace with `packages/api`, `packages/worker`, and `packages/shared`.
- Docker Compose for Postgres and Redis only. SQS and S3 are the real AWS free-tier services, hit from my laptop.
- Prisma 5 against Postgres, with an initial migration for tenants, events, deliveries, and the outbox table.
- `GET /health` on the API. It only answers “the process is up.” It does not check the database yet.
- Shared SQS/S3 client factories and `bun run check:aws`, which calls `GetQueueAttributes` and `HeadBucket` on the queue and bucket in `.env`.

## What I learned

**Keep local infra and cloud infra in different boxes.**  
Postgres and Redis are easy to run in Docker. SQS and S3 are not worth emulating for this project. Using the real services from day one means IAM, regions, and timeouts show up immediately, not as a surprise at deploy time.

**`localhost` is not always the process you think it is.**  
I already had PostgreSQL 18 installed on Windows, bound to `127.0.0.1:5432`. Prisma was authenticating against that instance, not the Docker container, so user `webhook` failed even though Compose was healthy. I published the container on host port `55432` and pointed `DATABASE_URL` at `127.0.0.1:55432`. The local Postgres install can stay for other work.

**Pin the Prisma CLI you actually depend on.**  
A bare `bunx prisma` resolved Prisma 7, which no longer accepts `url` in `schema.prisma`. The app depends on Prisma 5. Generating and migrating through `prisma@5.22.0` made the schema valid again. Lesson: in a monorepo, “the latest CLI” is not “the CLI in package.json.”

**IAM should match the operation, not a tutorial list.**  
The first check used `ListQueues` / `ListBuckets`. Those are account-wide actions, so a user scoped to one queue correctly got `AccessDenied`. The check now talks to `SQS_QUEUE_URL` and `S3_BUCKET_NAME` only. That matches how this project should be credentialed: one queue, one bucket, no admin policy.

**Every remote call needs a deadline.**  
The AWS helpers abort the SDK request after eight seconds. Racing a timer without aborting would leave the HTTP call running in the background. If AWS hangs, the process should fail clearly, not sit there.

**Secrets stay out of git.**  
`.env` is local. `.env.example` is the only env file in the repo. Access keys, the account id, and the real queue/bucket names do not belong in commits.

## Checkpoint

| Check | Result |
|---|---|
| `docker compose up -d postgres redis` | Postgres on `55432`, Redis on `6379` |
| `bun run prisma:migrate` | `20260822102754_init` applied |
| `GET /health` | `{ "status": "ok" }` |
| `bun run check:aws` | SQS and S3 reachable with a scoped IAM user |

Next is Phase 1: `POST /events` writes an event and an outbox row in one transaction, and oversized payloads go to S3 first.
