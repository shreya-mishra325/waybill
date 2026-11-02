import { expect, test } from "bun:test";
import { deliveryDetailsPath, deliveryHistoryPath, deliveryListReducer, initialDeliveryQuery } from "../src/lib/delivery-list";
import { parseDeliveryHistoryQuery, deliveryHistoryCursor } from "../../api/src/services/delivery-history-query";

const tenantId = "9abcde00-1234-4234-8234-123456789012";
const id = "9abcde01-1234-4234-8234-123456789012";
function backendQuery(path: string) {
  const url = new URL(path, "http://127.0.0.1:3000");
  return parseDeliveryHistoryQuery(tenantId, Object.fromEntries(url.searchParams));
}
test("Deliveries queries round-trip through the actual backend status, page-size and cursor parser", () => {
  for (const filter of ["ALL", "PENDING", "IN_FLIGHT", "SUCCEEDED", "FAILED", "DEAD_LETTERED"] as const) {
    for (const limit of [10, 25, 50, 100] as const) {
      const query = { ...initialDeliveryQuery, filter, limit };
      const parsed = backendQuery(deliveryHistoryPath(tenantId, query));
      expect(parsed.status).toBe(filter === "ALL" ? undefined : filter);
      expect(parsed.limit).toBe(limit);
      const cursor = deliveryHistoryCursor(parsed, { id, createdAt: new Date("2026-11-01T12:00:00Z") });
      const next = deliveryListReducer(query, { type: "next", cursor });
      expect(backendQuery(deliveryHistoryPath(tenantId, next)).cursor).toEqual({ id, createdAt: new Date("2026-11-01T12:00:00Z") });
    }
  }
});
test("Previous restores the exact cursor and filter/size changes discard the cursor chain", () => {
  const first = initialDeliveryQuery;
  const second = deliveryListReducer(first, { type: "next", cursor: "second" });
  const third = deliveryListReducer(second, { type: "next", cursor: "third" });
  expect(deliveryListReducer(third, { type: "previous" })).toEqual(second);
  expect(deliveryListReducer(second, { type: "previous" })).toEqual(first);
  expect(deliveryListReducer(first, { type: "previous" })).toBe(first);
  expect(deliveryListReducer(third, { type: "filter", filter: "FAILED" }).cursors).toEqual([null]);
  expect(deliveryListReducer(third, { type: "limit", limit: 10 }).cursors).toEqual([null]);
  expect(deliveryListReducer(third, { type: "refresh" })).toEqual({ ...third, revision: 1 });
  expect(deliveryDetailsPath(tenantId, id)).toBe(`/app/${tenantId}/deliveries/${id}`);
});
test("backend cursors cannot be reused for another workspace or status", () => {
  const parsed = backendQuery(deliveryHistoryPath(tenantId, initialDeliveryQuery));
  const cursor = deliveryHistoryCursor(parsed, { id, createdAt: new Date("2026-11-01T12:00:00Z") });
  const next = deliveryListReducer(initialDeliveryQuery, { type: "next", cursor });
  expect(() => backendQuery(deliveryHistoryPath(tenantId, { ...next, filter: "FAILED" }))).toThrow();
  const url = new URL(deliveryHistoryPath(tenantId, next), "http://127.0.0.1:3000");
  expect(() => parseDeliveryHistoryQuery(crypto.randomUUID(), Object.fromEntries(url.searchParams))).toThrow();
});
