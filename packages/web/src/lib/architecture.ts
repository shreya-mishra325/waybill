export const ARCHITECTURE_NODES = [
  { id: "application", title: "Your application", caption: "Send an event", detail: "Submit a tenant ID, event type and payload to POST /events. The worker sends to its configured RECEIVER_URL." },
  { id: "ingestion", title: "Ingestion", caption: "Validate & persist", detail: "The API validates the event, checks the tenant and enforces its ingestion rate limit. Payloads above the configured size threshold are uploaded to S3 before the database transaction." },
  { id: "postgres", title: "PostgreSQL", caption: "Transactional outbox", detail: "The event and its outbox entry are committed in one database transaction. The API returns success after that commit, before webhook delivery." },
  { id: "poller", title: "Outbox poller", caption: "Publish saved events", detail: "A dedicated poller holds a PostgreSQL advisory lock, reads pending outbox entries across tenants and sends them to SQS. It marks an entry published only after SQS confirms the send." },
  { id: "queue", title: "Queue (SQS)", caption: "Buffer delivery work", detail: "SQS carries the event envelope, with an S3 pointer for oversized payloads. Workers receive messages and maintain visibility while they own buffered work." },
  { id: "workers", title: "Workers", caption: "Sign & deliver", detail: "Workers apply per-tenant delivery limits and destination circuit breakers, load the payload, record attempts and send an HMAC-SHA256 signed HTTP request." },
  { id: "destination", title: "Destination", caption: "Your HTTP endpoint", detail: "The receiver gets the signed event envelope. A successful response is recorded before the queue message is deleted. Receivers should handle duplicate event IDs safely." },
  { id: "retry", title: "Retry", caption: "Backoff with jitter", detail: "A failed attempt schedules exponential backoff with jitter using ChangeMessageVisibility on the same SQS message. A rate limit or open circuit can also defer that message without an HTTP attempt." },
  { id: "dead-letter", title: "Dead letter", caption: "PostgreSQL + S3", detail: "After the attempt limit, the worker ensures an S3 payload archive exists and persists a dead-letter record in PostgreSQL before deleting the queue message. This is not a separate SQS dead-letter queue." },
] as const;

export type ArchitectureNodeId = typeof ARCHITECTURE_NODES[number]["id"];

export const DATA_FLOW = [
  { title: "Accept the event", text: "POST /events validates the tenant and payload, applies the ingestion limit and uploads oversized payloads to S3." },
  { title: "Commit event + outbox", text: "PostgreSQL saves both records atomically. The API response confirms persistence, not delivery to the destination." },
  { title: "Publish through the poller", text: "The advisory-lock leader sends pending outbox entries to SQS, then marks confirmed sends as published. Failed publications remain pending." },
  { title: "Attempt delivery", text: "Workers receive queue messages, apply delivery limits and circuit breakers, and POST the HMAC-signed envelope to the configured receiver URL." },
  { title: "Record the outcome", text: "Success is saved before queue deletion. Failures defer the same message with backoff; exhausted attempts are archived in S3 and recorded as dead letters." },
] as const;

export const DELIVERY_GUARANTEES = [
  { title: "Atomic acceptance", text: "The event and outbox entry share one PostgreSQL transaction. Acceptance means the event was saved, not that its endpoint has received it." },
  { title: "At-least-once delivery", text: "Duplicate sends remain possible, including a crash after SQS accepts a publication or after the receiver accepts a webhook. Deduplicate by event ID at the receiver." },
  { title: "Bounded automatic retries", text: "Failed attempts use exponential backoff with jitter and a configurable attempt limit. A permanently failing endpoint is not guaranteed eventual delivery." },
  { title: "Durable failure recovery", text: "Exhausted deliveries retain a PostgreSQL dead-letter record and an S3 payload archive. Explicit replay creates a new event and outbox entry; it is not automatic." },
] as const;
