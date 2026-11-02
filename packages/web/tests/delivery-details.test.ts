import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardApiError } from "../src/lib/dashboard-api";
import { deliveryStatuses, type DeliveryRecord } from "../src/lib/dashboard-types";
import { deliveryRecordJson, findDeliveryRecord, jsonLineTokens, scheduledRetry } from "../src/lib/delivery-details";
import { DeliveryRecordViewer } from "../src/components/dashboard/delivery-record-viewer";
import { DeliveryResultPanel } from "../src/components/dashboard/delivery-details";

const tenantId = "9abcde00-1234-4234-8234-123456789012";
const row: DeliveryRecord = { id: "9abcde01-1234-4234-8234-123456789012", eventId: "9abcde02-1234-4234-8234-123456789012", tenantId, event: { type: "order.shipped" }, targetUrl: "https://example.com/webhook", status: "FAILED", attemptCount: 2, createdAt: "2026-11-02T12:00:00.000Z", lastAttemptAt: "2026-11-02T12:01:00.000Z", nextAttemptAt: "2026-11-02T12:05:00.000Z", lastError: "HTTP 500" };

test("Details distinguishes every stored status from a scheduled retry and renders absent timestamps honestly", () => {
  for (const status of deliveryStatuses) {
    const record = { ...row, status };
    expect(scheduledRetry(record)).toBe(status === "FAILED" ? row.nextAttemptAt : null);
    const html = renderToStaticMarkup(createElement(DeliveryResultPanel, { record }));
    expect(html).toContain(status);
    expect(html.includes("awaiting retry")).toBe(status === "FAILED");
    expect(html.includes("No retry scheduled")).toBe(status !== "FAILED");
  }
  const pending = { ...row, status: "PENDING" as const, attemptCount: 0, lastAttemptAt: null, nextAttemptAt: null, lastError: null };
  const html = renderToStaticMarkup(createElement(DeliveryResultPanel, { record: pending }));
  expect(html).toContain("Not attempted yet");
  expect(html).toContain("No error recorded.");
  expect(html).toContain("No retry scheduled");
  expect(scheduledRetry({ status: "FAILED", nextAttemptAt: null })).toBeNull();
  expect(renderToStaticMarkup(createElement(DeliveryResultPanel, { record: { ...pending, attemptCount: 2 } }))).toContain("Not recorded");
});
test("record JSON preserves API values, nulls and escaping without inventing payload or response fields", () => {
  const record = { ...row, event: { type: 'order.\"shipped\"' }, lastError: '<script>alert("x")</script>\nUnicode: 你好' };
  const json = deliveryRecordJson(record);
  expect(JSON.parse(json)).toEqual(record);
  expect(Object.keys(JSON.parse(json))).toEqual(["id", "eventId", "tenantId", "targetUrl", "status", "attemptCount", "createdAt", "lastAttemptAt", "nextAttemptAt", "lastError", "event"]);
  const nullable = { ...row, nextAttemptAt: null, lastAttemptAt: null, lastError: null };
  expect(JSON.parse(deliveryRecordJson(nullable))).toEqual(nullable);
  for (const line of json.split("\n")) expect(jsonLineTokens(line).map(token => token.text).join("")).toBe(line);
  const tokens = jsonLineTokens('  "lastError": "an escaped \\"quote\\" and : colon",');
  expect(tokens.find(token => token.kind === "key")?.text).toBe('"lastError"');
  expect(tokens.some(token => token.kind === "string")).toBe(true);
  const html = renderToStaticMarkup(createElement(DeliveryRecordViewer, { record }));
  expect(html).toContain("details-json-key");
  expect(html).toContain("details-json-string");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("Copy delivery record JSON");
});
test("direct entry uses one bounded tenant history request and never invents a lookup endpoint", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; options?: RequestInit }[] = [];
  let response: unknown = { items: [row], nextCursor: "older-records" };
  let status = 200;
  globalThis.fetch = (async (url: unknown, options?: RequestInit) => { calls.push({ url: String(url), options }); return Response.json(response, { status }); }) as typeof fetch;
  try {
    expect((await findDeliveryRecord("http://127.0.0.1:3000", tenantId, row.id)).record).toEqual(row);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:3000/tenants/${tenantId}/deliveries?limit=100`);
    expect(calls[0]?.options?.credentials).toBe("include");
    expect(calls[0]?.options?.signal).toBeDefined();
    expect(await findDeliveryRecord("http://127.0.0.1:3000", tenantId, crypto.randomUUID())).toEqual({ record: null, limited: true });
    expect(calls).toHaveLength(2);
    expect(await findDeliveryRecord("http://127.0.0.1:3000", tenantId, "invalid-id")).toEqual({ record: null, limited: false });
    expect(calls).toHaveLength(2);
    response = { items: [{ ...row, tenantId: crypto.randomUUID() }], nextCursor: null };
    await expect(findDeliveryRecord("http://127.0.0.1:3000", tenantId, row.id)).rejects.toThrow(DashboardApiError);
    for (const denied of [401, 403, 404, 503]) {
      status = denied;
      await expect(findDeliveryRecord("http://127.0.0.1:3000", tenantId, row.id)).rejects.toMatchObject({ status: denied });
    }
  } finally { globalThis.fetch = original; }
});
