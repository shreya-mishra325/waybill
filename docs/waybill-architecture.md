# Waybill - target architecture

Target architecture for Phases 0-8 of [the project guide](./project-guide.md). Implementation status is tracked in Section 6.

The [PDF](./waybill-architecture.pdf) is an earlier Phases 0-5 snapshot. The Mermaid diagrams below describe the current target.

## 1. System overview

The delivery path runs left to right. Purple nodes indicate planned Phase 6-7 components. Solid edges represent requests and data operations; dashed edges represent control checks or replication.

```mermaid
flowchart LR
  producer["Tenant backend"]
  receiver["Tenant webhook endpoint"]
  operator["Tenant / operator"]

  subgraph platform["Waybill - TypeScript on Bun"]
    subgraph apiService["API - packages/api"]
      ingest["Ingestion API<br/>Validate and accept events"]
      queries["Observability API - Phase 7<br/>History, success rates, dead letters"]
      replay["Replay API - Phase 7<br/>Prepare failed delivery for replay"]
    end
    poller["Outbox poller<br/>One active leader; standby instances"]
    worker["Delivery workers<br/>Dispatch, retry, record outcomes"]
    signer["HMAC-SHA256 signing - Phase 6<br/>Per-tenant secret; signature header"]
    dashboard["Dashboard - Phase 7<br/>packages/dashboard"]
  end

  subgraph stores["Data and infrastructure"]
    primary[("PostgreSQL primary<br/>tenants, events, outbox,<br/>deliveries, dead_letters")]
    replica[("PostgreSQL read replica - Phase 7<br/>Separate read connection")]
    queue["Amazon SQS standard queue<br/>At-least-once transport<br/>Tenant fair scheduling"]
    redis[("Redis<br/>Tenant token buckets,<br/>destination circuit breakers,<br/>hot configuration cache")]
    s3[("Amazon S3<br/>Large payloads and<br/>dead-letter archives")]
  end

  producer -->|"POST /events"| ingest
  ingest -.->|"Check ingestion tokens"| redis
  ingest -->|"Upload oversized payload before DB transaction"| s3
  ingest -->|"Write event + outbox in one transaction"| primary
  poller -.->|"Session advisory lock on dedicated connection"| primary
  poller -->|"Read unpublished outbox; mark published after send"| primary
  poller -->|"Send payload or S3 reference; group by tenantId"| queue
  queue -->|"Workers long-poll for messages"| worker
  worker -.->|"Check dispatch tokens and destination circuit"| redis
  worker -->|"Load large payload; archive exhausted failure"| s3
  worker -->|"Read tenant / delivery; write attempts and outcome"| primary
  worker -->|"Resolved payload and tenant secret"| signer
  signer -->|"Signed HTTP POST"| receiver
  worker -->|"Change visibility for retry; delete after completion"| queue

  operator --> dashboard
  dashboard -->|"Read views"| queries
  queries -->|"Read-only queries"| replica
  queries -->|"Retrieve archived payload"| s3
  primary -.->|"Asynchronous replication"| replica
  dashboard -->|"Request manual replay"| replay
  replay -->|"Validate current state; write replay state"| primary
  replay -->|"Re-send eligible delivery"| queue

  classDef planned fill:#f3e8ff,stroke:#7e22ce,color:#3b0764;
  class queries,replay,signer,dashboard,replica planned;
```

HMAC signing is part of the delivery worker. Observability and replay are API modules. The outbox poller and delivery worker are separate processes within `packages/worker`.

Dashboard queries use a dedicated read-replica connection. Replay validates authoritative state and persists changes on the primary. Dashboard views are eventually consistent due to replication lag. Tenant configuration caching remains planned.

## 2. Ingestion and outbox publication

```mermaid
sequenceDiagram
  participant T as Tenant backend
  participant A as Ingestion API
  participant R as Redis
  participant S as S3
  participant P as PostgreSQL primary
  participant O as Outbox poller
  participant Q as SQS

  T->>A: POST /events { tenantId, type, payload }
  A->>A: Validate request
  A->>P: Verify tenant exists
  A->>R: Consume tenant ingestion token
  alt No token available
    A-->>T: 429 with Retry-After
  else Allowed
    opt Payload exceeds configured claim-check threshold
      A->>S: Upload JSON payload
      S-->>A: Upload confirmed
    end
    A->>P: Transaction: insert event and outbox row
    Note over A,P: Store inline JSON or payloadS3Key
    P-->>A: Commit confirmed
    A-->>T: 201 { eventId, outboxId, storedIn }
  end

  O->>P: Acquire pg_try_advisory_lock on one connection
  alt Leader
    loop Poll unpublished rows
      O->>P: Read outbox with event
      O->>Q: SendMessage with payload or S3 reference
      Q-->>O: Send confirmed
      O->>P: Mark outbox published
    end
  else Standby
    Note over O,P: Wait and retry acquiring the lock
  end
```

- The API commits the event and outbox entry atomically. The poller handles SQS publication.
- The configured claim-check threshold is 256 KiB. This is a project setting, not the current AWS service limit. Size checks also need to account for the message envelope and attributes.
- The current queue body is `{ eventId, tenantId, type, payload, payloadS3Key }`, with `tenantId` also a message attribute and `MessageGroupId` set to the same tenant ID. The S3 bucket comes from configuration. Correlation-ID propagation is a production-readiness target.
- S3 upload happens before the transaction. A failed transaction can leave an orphan object, but cannot commit an event without its outbox row.
- A crash after `SendMessage` but before marking the row published can produce a duplicate. Advisory locks coordinate pollers; they do not make PostgreSQL and SQS one atomic transaction.

## 3. Delivery lifecycle

This flow includes the pre-attempt tenant selection budget and Phase 6 HMAC signing. Malformed-message handling is omitted; the current worker logs and deletes invalid queue messages.

```mermaid
flowchart TD
  receive["Long-poll SQS"] --> turn{"Tenant turn available?"}
  turn -->|"No"| defer
  turn -->|"Yes"| circuit{"Destination circuit allows attempt?"}
  circuit -->|"No"| defer["Change message visibility<br/>Do not increment attempt count"]
  circuit -->|"Yes"| tokens{"Tenant dispatch token available?"}
  tokens -->|"No"| defer
  tokens -->|"Yes"| state{"Delivery state?"}
  state -->|"Already succeeded or dead-lettered"| remove["Delete SQS message"]
  state -->|"Retry not due"| defer
  state -->|"Eligible"| attempt["Persist IN_FLIGHT<br/>Increment attempt count"]
  attempt --> payload["Load inline payload or fetch from S3"]
  payload -->|"Load succeeds"| sign["Sign serialized body with tenant secret<br/>Phase 6"]
  payload -->|"Load fails"| exhausted{"Attempt budget exhausted?"}
  sign --> post["HTTP POST with signature header<br/>Receiver verifies signature in Phase 6"]
  post -->|"HTTP 2xx"| success["Reset circuit<br/>Persist SUCCEEDED"]
  success --> remove
  post -->|"Non-2xx, timeout, or network failure"| failure["Record destination circuit failure"]
  failure --> exhausted
  exhausted -->|"No"| retry["Persist FAILED and nextAttemptAt<br/>Exponential backoff with full jitter"]
  retry --> defer
  exhausted -->|"Yes"| archive["Ensure payload archived in S3"]
  archive --> dead["Persist dead-letter record<br/>Mark delivery DEAD_LETTERED"]
  dead --> remove
  defer --> later["Message becomes eligible after visibility expires"]
  later --> receive

  classDef planned fill:#f3e8ff,stroke:#7e22ce,color:#3b0764;
  class sign planned;
```

Retries retain the existing SQS message and change its visibility; they do not publish a replacement message. If archiving or persistence fails, the worker must leave the message undeleted so it can be processed again.

The delivery guarantee is **at least once**, with bounded automatic retries and durable dead letters. A permanently unavailable endpoint cannot be guaranteed to receive an event. Receivers must tolerate duplicate `eventId` values. A redelivery with an existing `SUCCEEDED` record is acknowledged without repeating the webhook, but a crash between HTTP success and persistence can still cause duplicates.

The publisher selects pending rows in tenant rounds and sends up to ten concurrently. It sets `MessageGroupId = tenantId` to enable SQS standard-queue fair scheduling; a custom message attribute alone does not enable it. Its starting tenant rotates between batches. Productive batches continue immediately; idle polls and failures retain a delay. The worker uses up to ten concurrent long polls and buffers at most one hundred messages. Webhook deliveries remain sequential. Each receive cycle selects up to ten messages per tenant and defers excess messages in visibility batches. Reservations are renewed for waiting/active work and released before retry delays or deletion. Completed SQS deletions overlap within the ten-message response being processed.

## 4. Observability and replay (Phase 7)

```mermaid
sequenceDiagram
  actor U as Tenant / operator
  participant D as Dashboard
  participant A as Observability / replay API
  participant R as PostgreSQL read replica
  participant P as PostgreSQL primary
  participant S as S3
  participant Q as SQS
  participant W as Delivery worker

  U->>D: Browse delivery history or dead letters
  D->>A: Request tenant view
  A->>R: Read tenant delivery / dead-letter records
  R-->>A: Records, possibly behind primary
  opt View archived payload
    A->>S: GetObject using stored archive key
    S-->>A: Payload
  end
  A-->>D: View data

  U->>D: Replay selected failed delivery
  D->>A: Submit replay command
  A->>P: Validate latest state and prepare eligible delivery
  Note over A,P: Define replay identity, attempt reset, and audit history in Phase 7
  A->>Q: SendMessage with payload or archive reference
  Q-->>W: Message received through long polling
  W->>W: Run normal rate-limit, circuit, signing, and delivery path
  W->>P: Persist new outcome
  P-->>R: Replicate updated records
```

Replay semantics are pending Phase 7. Replayed messages must retain `MessageGroupId = tenantId` for fair scheduling. The worker discards messages associated with a `DEAD_LETTERED` delivery, so replay must transition the delivery to an eligible state or create a new delivery record. The implementation must define attempt accounting, audit history, command idempotency, and recovery from a crash between the database write and SQS publication. Extending the transactional outbox is one option.

## 5. Target repository layout

Annotations distinguish existing modules from planned additions. File-level design is deferred to the relevant phase.

```text
waybill/
├── packages/
│   ├── api/
│   │   └── src/
│   │       ├── index.ts                 Express application and health endpoint
│   │       ├── routes/                  Ingestion; observability/replay planned
│   │       ├── controllers/             HTTP input/output and error mapping
│   │       ├── services/                Business rules and transactions
│   │       ├── repositories/            DB access; replica reads planned
│   │       ├── middleware/              Placeholder for cross-cutting HTTP logic
│   │       └── rate-limit.ts            Ingestion token enforcement
│   ├── worker/
│   │   └── src/
│   │       ├── index.ts                 SQS receive and delivery orchestration
│   │       ├── outbox-poller.ts         Separate publisher process and leader lock
│   │       ├── delivery/                HTTP, backoff, circuit breaker, rate limits
│   │       │                           HMAC signing planned in Phase 6
│   │       ├── repositories/            Outbox, deliveries, dead letters
│   │       └── jobs/                    Existing placeholder
│   ├── shared/
│   │   ├── src/                        Prisma, AWS clients, queue and rate-limit types
│   │   │                               Separate replica client planned in Phase 7
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   └── scripts/                    AWS check, seed, event clients, receiver
│   └── dashboard/                      Planned in Phase 7; framework not selected
├── docs/                               Guide, phase notes, architecture
├── docker-compose.yml                  Local Postgres/Redis; API/worker definitions
├── .env.example
└── package.json                        Bun workspace and development commands
```

The dashboard calls the API; it never receives database credentials. API layering remains `routes → controllers → services → repositories`. Shared code provides common clients and types rather than HTTP business logic.

## 6. Phase boundaries and operational requirements

| Scope | Target | Current repository |
|---|---|---|
| Phases 0-3 | Ingestion, outbox, leader election, delivery, retries, dead letters | Implemented with phase notes |
| Phase 4 | Per-destination circuit breaker with one recovery probe | Implemented; atomic cross-worker probe coordination still needs hardening |
| Phase 5 | Tenant limits at ingestion and dispatch; demonstrated noisy-tenant fairness | Independent buckets, tenant rotation in publication, and overlapping SQS acknowledgements implemented; rate-limited 10k-request check passed at 25.7-second quiet p95; accepted-backlog p95 passed at 25.2 seconds with explicit tenant turns and batched deferral; quiet maximum 63.5 seconds and busy-throughput cost remain hardening work |
| Phase 6 | HMAC signing and receiver verification | Planned; tenant secret field already exists |
| Phase 7 | Dashboard, observability API, payload viewing, replay, read replica | Planned |
| Phase 8 | Measure bottlenecks and harden the system | Planned; shard deliveries by tenant only if measurements justify it |
| Phase 9 | FIFO ordering, Prometheus/Grafana, multiple regions, Kafka exploration | Optional extensions, outside the baseline diagram |

Delivery currently uses a single configured `RECEIVER_URL`. Per-tenant destination resolution requires a configuration API and schema changes that are not yet specified.

Production requirements include external-call deadlines, graceful shutdown, liveness/readiness probes, structured Pino logs with correlation IDs, Sentry, scoped IAM, environment-based secrets, CI migration checks, database backups, and S3 lifecycle policies. Implementation status must be verified against the guide's readiness checklist. Successful-delivery archiving has no assigned phase; the diagrams cover claim-check storage and dead-letter archives.

Local infrastructure consists of containerized PostgreSQL and Redis with AWS-hosted SQS and S3. Initial deployment targets Railway or Render with managed PostgreSQL and Redis. A full AWS deployment is optional. Any sharding introduced after load testing must account for repository routing, cross-tenant queries, and replica reads.
