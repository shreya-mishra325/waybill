import { describe, expect, it } from "bun:test";
import { VisibilityLeases } from "./visibility";

describe("buffered message visibility", () => {
  it("renews in batches of at most ten and excludes released receipts", async () => {
    let now = 0;
    const batches: string[][] = [];
    const leases = new VisibilityLeases(async (receipts) => {
      batches.push(receipts);
      return new Set(receipts);
    }, (err) => { throw err; }, () => now);
    try {
      for (let i = 0; i < 23; i++) leases.track(String(i));
      await leases.release("0");
      now = 20_000;
      await leases.renewNow();
      expect(batches.map((batch) => batch.length)).toEqual([10, 10, 2]);
      expect(batches.flat().includes("0")).toBe(false);
      now = 35_000;
      expect(leases.isCurrent("1")).toBe(true);
      expect(leases.isCurrent("0")).toBe(false);
    } finally { await leases.stop(); }
  });

  it("waits for an in-flight renewal before releasing for a custom retry delay", async () => {
    let finish: (value: Set<string>) => void = () => {};
    const response = new Promise<Set<string>>((resolve) => { finish = resolve; });
    const leases = new VisibilityLeases(async () => response, (err) => { throw err; });
    try {
      leases.track("receipt");
      const renewal = leases.renewNow();
      let released = false;
      const release = leases.release("receipt").then(() => { released = true; });
      await Promise.resolve();
      expect(released).toBe(false);
      finish(new Set(["receipt"]));
      await Promise.all([renewal, release]);
      expect(released).toBe(true);
      expect(leases.isCurrent("receipt")).toBe(false);
    } finally { await leases.stop(); }
  });

  it("invalidates failed entries and failed requests before more work starts", async () => {
    const errors: unknown[] = [];
    const leases = new VisibilityLeases(async (receipts) => new Set(receipts.filter((r) => r === "ok")),
      (err) => { errors.push(err); });
    const failed = new VisibilityLeases(async () => { throw new Error("SQS unavailable"); },
      (err) => { errors.push(err); });
    try {
      leases.track("ok"); leases.track("missing"); failed.track("request-error");
      await Promise.all([leases.renewNow(), failed.renewNow()]);
      expect(leases.isCurrent("ok")).toBe(true);
      expect(leases.isCurrent("missing")).toBe(false);
      expect(failed.isCurrent("request-error")).toBe(false);
      expect(errors.length).toBe(2);
    } finally { await Promise.all([leases.stop(), failed.stop()]); }
  });

  it("does not renew already-expired ownership or allow work near expiry", async () => {
    let now = 0;
    let requests = 0;
    const leases = new VisibilityLeases(async (receipts) => { requests++; return new Set(receipts); },
      (err) => { throw err; }, () => now);
    try {
      leases.track("receipt");
      now = 26_000;
      expect(leases.isCurrent("receipt")).toBe(false);
      now = 31_000;
      await leases.renewNow();
      expect(requests).toBe(0);
      expect(leases.isCurrent("receipt")).toBe(false);
    } finally { await leases.stop(); }
  });
});
