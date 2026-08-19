// Phase 0 entrypoint: placeholder only. The real long-poll loop that reads
// from Amazon SQS, checks Redis (rate limit + circuit breaker), and POSTs
// to tenant endpoints gets built in Phase 2 — see
// docs/project-guide.md before adding logic here.

console.log("worker booted — no SQS polling loop wired up yet (see Phase 2)");
