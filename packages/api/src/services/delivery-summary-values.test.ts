import { describe, expect, test } from "bun:test";
import { summarizeDeliveries } from "./delivery-summary-values";

describe("delivery summary", () => {
  test("reports zero counts and no rate when there are no deliveries", () => {
    expect(summarizeDeliveries([])).toEqual({ total: 0, completed: 0, successRatePercent: null,
      counts: { PENDING: 0, IN_FLIGHT: 0, SUCCEEDED: 0, FAILED: 0, DEAD_LETTERED: 0 } });
  });

  test("counts unfinished work but excludes it from the terminal success rate", () => {
    const summary = summarizeDeliveries([
      {status: "PENDING", _count: {_all: 10}}, {status: "IN_FLIGHT", _count: {_all: 5}},
      {status: "FAILED", _count: {_all: 7}}, {status: "SUCCEEDED", _count: {_all: 2}},
      {status: "DEAD_LETTERED", _count: {_all: 1}},
    ]);
    expect(summary.total).toBe(25);
    expect(summary.completed).toBe(3);
    expect(summary.successRatePercent).toBe(66.67);
    expect(summary.counts.FAILED).toBe(7);
  });

  test("does not invent a success rate for pending or retrying deliveries", () => {
    expect(summarizeDeliveries([{status: "FAILED", _count: {_all: 4}}]).successRatePercent).toBeNull();
    expect(summarizeDeliveries([{status: "PENDING", _count: {_all: 2}}]).successRatePercent).toBeNull();
  });

  test("handles all-successful and all-dead-lettered outcomes", () => {
    expect(summarizeDeliveries([{status: "SUCCEEDED", _count: {_all: 3}}]).successRatePercent).toBe(100);
    expect(summarizeDeliveries([{status: "DEAD_LETTERED", _count: {_all: 3}}]).successRatePercent).toBe(0);
  });
});
