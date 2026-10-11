# Waybill — target architecture

This is the intended final design from [the project guide](./project-guide.md), covering Phases 0–8. It is a design map, not a claim that every component is implemented. Mermaid keeps diagrams reviewable alongside code and renders in GitHub Markdown.

The earlier [Excalidraw board](./waybill-architecture.excalidraw) and [PDF](./waybill-architecture.pdf) are Phases 0–5 snapshots; they do not represent the complete target below.

## 1. System overview

Read the delivery path from left to right. Purple nodes are planned Phase 6–7 capabilities. Solid arrows show requests or data operations; dashed arrows show control checks or replication. Labels specify whether a store operation is a read or a write.

```mermaid
flowchart LR
  producer["Tenant backend"]
  receiver["Tenant webhook endpoint"]
  operator["Tenant / operator"]

  subgraph platform["Waybill — TypeScript on Bun"]
    subgraph apiService["API — packages/api"]
      ingest["Ingestion API<br/>Validate and accept events"]
      queries["Observability API — Phase 7<br/>History, success rates, dead letters"]
      replay["Replay API — Phase 7<br/>Prepare failed delivery for replay"]
    end
    poller["Outbox poller<br/>One active leader; standby instances"]
    worker["Delivery workers<br/>Dispatch, retry, record outcomes"]
    signer["HMAC-SHA256 signing — Phase 6<br/>Per-tenant secret; signature header"]
    dashboard["Dashboard — Phase 7<br/>packages/dashboard"]
  end

  subgraph stores["Data and infrastructure"]
    primary[("PostgreSQL primary<br/>tenants, events, outbox,<br/>deliveries, dead_letters")]
    replica[("PostgreSQL read replica — Phase 7<br/>Separate read connection")]
    queue["Amazon SQS standard queue<br/>At-least-once transport"]
    redis[("Redis<br/>Tenant token buckets,<br/>destination circuit breakers,<br/>hot configuration cache")]
    s3[("Amazon S3<br/>Large payloads and<br/>dead-letter archives")]
  end

  producer -->|"POST /events"| ingest
  ingest -.->|"Check ingestion tokens"| redis
  ingest -->|"Upload oversized payload before DB transaction"| s3
  ingest -->|"Write event + outbox in one transaction"| primary
  poller -.->|"Session advisory lock on dedicated connection"| primary
  poller -->|"Read unpublished outbox; mark published after send"| primary
  poller -->|"Send payload or S3 reference + tenantId"| queue
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

The signer and Phase 7 API boxes are logical responsibilities within the worker and API, not additional services. The outbox poller is a separate runnable process in `packages/worker`; starting the delivery worker does not start it.

Dashboard database reads use the replica. Replay is a command: its authoritative state checks and writes use the primary. Replica lag means the dashboard may briefly display an older delivery status. Hot configuration caching is a target from the guide, not yet implemented.

## 2. Accept and publish an event

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

- The ingestion endpoint does not publish to SQS. The committed outbox records the obligation to publish.
- The repository uses a 256 KiB claim-check threshold. Treat this as project configuration, rather than a statement about the current AWS service limit. Queue sizing must include the complete message envelope and attributes.
- The current queue body is `{ eventId, tenantId, type, payload, payloadS3Key }`, with `tenantId` also a message attribute. The S3 bucket comes from configuration. Correlation-ID propagation is a production-readiness target.
- S3 upload happens before the transaction. A failed transaction can leave an orphan object, but cannot commit an event without its outbox row.
- A crash after `SendMessage` but before marking the row published can produce a duplicate. Advisory locks coordinate pollers; they do not make PostgreSQL and SQS one atomic transaction.

## 3. Deliver, retry, or dead-letter

This is the intended delivery lifecycle, including Phase 6 signing. It omits malformed-message handling to keep the main path readable; today's worker logs and deletes malformed queue messages.

```mermaid
flowchart TD
  receive["Long-poll SQS"] --> circuit{"Destination circuit allows attempt?"}
  circuit -->|"No"| defer["Change message visibility<br/>Do not increment attempt count"]
  circuit -->|"Yes"| tokens{"Tenant dispatch token available?"}
  tokens -->|"No"| defer
  tokens -->|"Yes"| state{"Delivery state?"}
  state -->|"Already dead-lettered"| remove["Delete SQS message"]
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

The delivery guarantee is **at least once**, with bounded automatic retries and durable dead letters. A permanently unavailable endpoint cannot be guaranteed to receive an event. Receivers must tolerate duplicate `eventId` values. The current code also lacks an explicit skip for already-successful deliveries.

## 4. Observe and manually replay — Phase 7 target

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

The guide specifies manual re-send to SQS but does not yet define replay persistence or duplicate-command handling. Phase 7 must make the delivery eligible again: re-sending an unchanged `DEAD_LETTERED` delivery would be discarded by today's worker. It must also address a crash between the primary write and queue publication, for example by extending the outbox design. This is the logical flow, not a completed atomic replay protocol.

## 5. Target repository layout

Existing paths are shown without annotations. Entries marked **planned** describe responsibilities from the guide; exact files will be chosen in the relevant phase.

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
| Phases 0–3 | Ingestion, outbox, leader election, delivery, retries, dead letters | Implemented with phase notes |
| Phase 4 | Per-destination circuit breaker with one recovery probe | Implemented; atomic cross-worker probe coordination still needs hardening |
| Phase 5 | Tenant limits at ingestion and dispatch; demonstrated noisy-tenant fairness | Limiters implemented; both currently share one Redis key per tenant; fairness checkpoint not documented |
| Phase 6 | HMAC signing and receiver verification | Planned; tenant secret field already exists |
| Phase 7 | Dashboard, observability API, payload viewing, replay, read replica | Planned |
| Phase 8 | Measure bottlenecks and harden the system | Planned; shard deliveries by tenant only if measurements justify it |
| Phase 9 | FIFO ordering, Prometheus/Grafana, multiple regions, Kafka exploration | Optional extensions, outside the baseline diagram |

Today's worker sends every event to one configured `RECEIVER_URL`. The final product needs tenant destination resolution; the guide does not yet specify its configuration API or schema. The endpoint box represents that intended capability, not an existing endpoint-management feature.

The operational target also includes external-call timeouts, graceful shutdown, liveness/readiness checks, Pino logs with correlation IDs across API/SQS/worker, Sentry error tracking, scoped IAM, environment-managed secrets, migration checks in CI, database backups, and S3 retention. These are cross-cutting requirements from the guide, not additional delivery services or claims of current completeness. Successful-delivery payload archiving is mentioned in the guide's stack overview but has no defined phase checkpoint; the diagram shows the explicit claim-check and dead-letter archive paths.

Local development uses Docker for PostgreSQL and Redis and real AWS for SQS/S3. The initial hosted target is Railway or Render with managed PostgreSQL/Redis; moving compute and databases to AWS is optional. Any measured sharding change needs a revised diagram that also accounts for dashboard reads and replica routing.
