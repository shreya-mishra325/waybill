import { describe, expect, it } from "bun:test";
import { consumeToken } from "./rate-limiter";

describe("tenant token bucket", () => {
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