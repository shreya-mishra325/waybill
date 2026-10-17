# Phase 5 - Rate limiting and tenant fairness

Status: in progress. Ingestion and dispatch rate limits are implemented. The 10k-event noisy-tenant checkpoint has not been verified.

## Independent budgets

Ingestion and delivery use separate Redis token buckets for each tenant:

- `waybill:rate-limit:ingestion:tenant:{tenantId}`
- `waybill:rate-limit:delivery:tenant:{tenantId}`

Both paths previously consumed the same bucket. An ingestion burst could exhaust the tokens required to dispatch accepted events. Different ingestion and delivery configurations also operated on the same stored state.

The shared limiter now requires a scope at each call site. Each bucket still uses the existing atomic Lua script for refill and consumption. The default capacity and refill rate are 10 tokens and 10 tokens per second for each scope. The four configuration variables are listed in `.env.example`.

Ingestion returns HTTP 429 with `Retry-After` when its bucket is exhausted. The worker defers rate-limited messages using `ChangeMessageVisibility` without incrementing the delivery attempt count.

Existing unscoped keys expire through their TTL. New scoped keys start with full capacity, so deploying this change resets the available burst budget once.

## Regression coverage

The limiter tests verify burst exhaustion, refill, and isolation between scopes and tenants. The isolation test uses an in-memory implementation of the Redis EVAL interface to check key routing. It does not verify Lua execution, concurrent Redis access, or SQS scheduling.

## Remaining checkpoint

Run a repeatable test with one tenant submitting 10k events and a second tenant submitting low-volume traffic through the same queue. Record accepted requests, ingestion rejections, delivery completion, and per-tenant delivery latency. Define the acceptable latency before the run.

The test must exercise the API, outbox poller, Redis, SQS, worker, and receiver. Token-bucket unit tests alone do not establish fairness across the full pipeline.
