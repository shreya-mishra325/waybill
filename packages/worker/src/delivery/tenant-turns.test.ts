import { describe, expect, it } from "bun:test";
import { TenantTurns } from "./tenant-turns";

describe("tenant dispatch turns", () => {
  it("bounds busy-tenant selections without consuming a quiet tenant's turn", () => {
    const turns = new TenantTurns(10);
    const waiting = [...Array<string>(100).fill("busy"), "quiet", "quiet"];
    const ready: string[] = [];
    const deferred: string[] = [];
    for (const tenant of waiting) (turns.take(tenant) ? ready : deferred).push(tenant);
    expect(ready.filter((tenant) => tenant === "busy").length).toBe(10);
    expect(ready.filter((tenant) => tenant === "quiet").length).toBe(2);
    expect(deferred.length).toBe(90);
    expect(deferred.every((tenant) => tenant === "busy")).toBe(true);
    expect(ready.length + deferred.length).toBe(waiting.length);
  });

  it("starts fresh in the next bounded receive cycle", () => {
    const first = new TenantTurns(1);
    expect(first.take("busy")).toBe(true);
    expect(first.take("busy")).toBe(false);
    expect(new TenantTurns(1).take("busy")).toBe(true);
    expect(() => new TenantTurns(0)).toThrow();
  });
});
