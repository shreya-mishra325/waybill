import { describe, expect, it } from "bun:test";
import { consumeTenantToken, consumeToken } from "./rate-limiter";

describe("tenant token bucket", () => {
  it("keeps ingestion, dispatch, and other tenants' budgets independent", async () => {
    const buckets = new Map<string, { tokens: number; lastRefillAt: number }>();
    const redis = {
      async eval(_script: string, _keyCount: number, ...args: string[]) {
        const [key, capacity, refillPerSecond, timestamp] = args;
        const now = Number(timestamp);
        const config = {
          capacity: Number(capacity),
          refillPerSecond: Number(refillPerSecond),
        };
        const current = buckets.get(key) ?? {
          tokens: config.capacity,
          lastRefillAt: now,
        };
        const decision = consumeToken(current, now, config);
        buckets.set(key, decision.snapshot);
        return [Number(decision.allowed), decision.tokens, decision.retryAfterMs];
      },
    };
    const config = { capacity: 1, refillPerSecond: 1 };
    const consume = (tenantId: string, scope: "ingestion" | "delivery") =>
      consumeTenantToken(redis, tenantId, scope, config, 1_000);

    expect((await consume("tenant-a", "ingestion")).allowed).toBe(true);
    expect((await consume("tenant-a", "ingestion")).allowed).toBe(false);
    expect((await consume("tenant-a", "delivery")).allowed).toBe(true);
    expect((await consume("tenant-a", "delivery")).allowed).toBe(false);
    expect((await consume("tenant-b", "ingestion")).allowed).toBe(true);
    expect((await consume("tenant-b", "delivery")).allowed).toBe(true);
  });

  it("allows the configured burst and rejects the next token", () => {
    let state = { tokens: 3, lastRefillAt: 1_000 };

    for (let i = 0; i < 3; i += 1) {
      const decision = consumeToken(state, 1_000, {
        capacity: 3,
        refillPerSecond: 1,
      });
      expect(decision.allowed).toBe(true);
      state = decision.snapshot;
    }

    const rejected = consumeToken(state, 1_000, {
      capacity: 3,
      refillPerSecond: 1,
    });
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBe(1_000);
  });

  it("refills tokens over time without exceeding capacity", () => {
    const decision = consumeToken(
      { tokens: 0, lastRefillAt: 1_000 },
      3_500,
      { capacity: 3, refillPerSecond: 1 },
    );

    expect(decision.allowed).toBe(true);
    expect(decision.tokens).toBe(1.5);
  });
});
