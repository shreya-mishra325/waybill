import { describe, expect, test } from "bun:test";
import { deliveryHistoryCursor, parseDeliveryHistoryQuery } from "./delivery-history-query";

const tenantId = crypto.randomUUID();

describe("delivery history query", () => {
  test("bounds page sizes and rejects invalid or repeated query parameters", () => {
    expect(parseDeliveryHistoryQuery(tenantId, {}).limit).toBe(50);
    expect(parseDeliveryHistoryQuery(tenantId, { limit: "100", status: "FAILED" }).limit).toBe(100);
    for (const query of [{ limit: "0" }, { limit: "101" }, { limit: "1.5" }, { limit: "1e2" },
      { limit: ["1", "2"] }, { status: "unknown" }, { status: ["FAILED", "SUCCEEDED"] }, { extra: "x" }]) {
      expect(() => parseDeliveryHistoryQuery(tenantId, query)).toThrow();
    }
    expect(() => parseDeliveryHistoryQuery("not-a-uuid", {})).toThrow();
  });

  test("ties a pagination cursor to its tenant and status filter", () => {
    const query = parseDeliveryHistoryQuery(tenantId, { status: "FAILED" });
    const row = { id: crypto.randomUUID(), createdAt: new Date("2026-10-25T00:00:00.000Z") };
    const cursor = deliveryHistoryCursor(query, row);
    expect(parseDeliveryHistoryQuery(tenantId, { status: "FAILED", cursor }).cursor).toEqual(row);
    expect(() => parseDeliveryHistoryQuery(crypto.randomUUID(), { status: "FAILED", cursor })).toThrow();
    expect(() => parseDeliveryHistoryQuery(tenantId, { cursor })).toThrow();
    expect(() => parseDeliveryHistoryQuery(tenantId, { status: "SUCCEEDED", cursor })).toThrow();
  });

  test("rejects malformed cursor data and encoding", () => {
    for (const cursor of ["", "%%%", "a".repeat(1025), Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({tenantId, status: null, id: crypto.randomUUID(), createdAt: "invalid"})).toString("base64url")]) {
      expect(() => parseDeliveryHistoryQuery(tenantId, { cursor })).toThrow();
    }
  });
});
