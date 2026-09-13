import { describe, expect, it } from "bun:test";
import {
  applyFailure,
  getCircuitDecision,
  type CircuitSnapshot,
} from "./circuit-breaker";

describe("circuit breaker", () => {
  it("opens after the configured number of consecutive failures", () => {
    let state: CircuitSnapshot = { state: "closed", failureCount: 0 };

    for (let i = 0; i < 3; i += 1) {
      state = applyFailure(state, 1_000, {
        failureThreshold: 3,
        cooldownMs: 30_000,
      });
    }

    expect(state.state).toBe("open");
    expect(state.failureCount).toBe(3);
  });

  it("blocks attempts while the circuit is still in cooldown", () => {
    const decision = getCircuitDecision(
      { state: "open", failureCount: 3, openedAt: 1_000 },
      15_000,
      { failureThreshold: 3, cooldownMs: 30_000 },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.delayMs).toBeGreaterThan(0);
  });

  it("allows a single probe after the cooldown expires", () => {
    const decision = getCircuitDecision(
      { state: "open", failureCount: 3, openedAt: 0 },
      31_000,
      { failureThreshold: 3, cooldownMs: 30_000 },
    );

    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe("half-open");
  });
});
