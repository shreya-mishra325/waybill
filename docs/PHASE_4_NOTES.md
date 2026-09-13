# Phase 4 - Circuit breaker

Phase 3 proved the worker could retry and dead-letter failed deliveries. Phase 4 adds the next protective layer: a Redis-backed circuit breaker keyed by destination URL so a stubborn endpoint is not hammered while it is down.

## What I shipped

- Redis-backed breaker state stored under a per-target key.
- States follow the standard pattern: closed -> open -> half-open -> closed/open.
- The worker checks the breaker before every delivery attempt and hides the SQS message until the cooldown window expires if the target is open.
- Success resets the breaker to closed; failures increment the failure count and open the breaker after the configured threshold.
- A focused Bun test covers the open, cooldown, and half-open transitions.

## Verified

- `bun test packages/worker/src/delivery/circuit-breaker.test.ts` passes with 3/3 tests green.
- `bunx tsc -p packages/worker/tsconfig.json --noEmit` exits successfully.

## What I learned

**The breaker is about protecting the target, not the queue.**
The queue is still the durable transport. The circuit breaker is a local safety valve in the worker: if a destination consistently fails, the worker does not keep retrying it aggressively while it is already unhealthy.

**The decision must happen before the POST.**
The worker checks the breaker at receive time, before loading payloads, before hitting the tenant endpoint, and before counting another retry as a real delivery attempt. This prevents a healthy circuit from getting trampled by a loud failure pattern.

**Half-open is the probing period.**
Once the cooldown expires, the circuit allows a single probe. If that probe succeeds, we reset to closed. If it fails, we reopen immediately. This keeps the system from blindly retrying every message during a storm while still allowing recovery.

**Redis is the right place for this state.**
This state is small, fast, and shared across worker processes. It fits the Redis pattern better than a database table for per-destination health tracking, while keeping the durable source of truth in Postgres for deliveries and dead letters.

## Next step

The project is ready to continue with Phase 5: per-tenant rate limiting and fairness across a shared SQS queue.
