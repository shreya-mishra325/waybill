import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardApiError, requestDashboardApi } from "../src/lib/dashboard-api";
import { archivedPayloadJson, canRequestReplay, deadLetterError, deadLetterListPath, deadLetterQueryReducer, initialDeadLetterQuery, readDeadLetterHistory, readReplayReceipt, submitDeadLetterReplay, type DeadLetterRecord } from "../src/lib/dead-letters";
import { ArchivedPayloadViewer } from "../src/components/dashboard/archived-payload-viewer";
import { deadLetterCursor, parseDeadLetterQuery } from "../../api/src/services/dead-letter-query";
import { parseReplayQuery } from "../../api/src/services/replay-query";

const tenantId = "9abcde00-1234-4234-8234-123456789012";
const row: DeadLetterRecord = { id: "9abcde01-1234-4234-8234-123456789012", eventId: "9abcde02-1234-4234-8234-123456789012", deliveryId: "9abcde03-1234-4234-8234-123456789012", tenantId, targetUrl: "https://example.com/webhook", lastError: "HTTP 500", attemptCount: 5, createdAt: "2026-11-02T12:00:00.000Z", event: { type: "order.cancelled" }, replay: null };
const receipt = { replayId: "9abcde04-1234-4234-8234-123456789012", deadLetterId: row.id, originalEventId: row.eventId, eventId: "9abcde05-1234-4234-8234-123456789012", createdAt: "2026-11-02T12:05:00.000Z" };

test("dead-letter pagination uses the actual backend cursor and page-size contracts", () => {
  for (const limit of [10, 20, 50, 100] as const) {
    const query = { ...initialDeadLetterQuery, limit };
    const url = new URL(deadLetterListPath(tenantId, query), "http://127.0.0.1");
    const parsed = parseDeadLetterQuery(tenantId, Object.fromEntries(url.searchParams));
    expect(parsed.limit).toBe(limit);
    const cursor = deadLetterCursor(parsed, { id: row.id, createdAt: new Date(row.createdAt) });
    const next = deadLetterQueryReducer(query, { type: "next", cursor });
    const nextUrl = new URL(deadLetterListPath(tenantId, next), url.origin);
    expect(parseDeadLetterQuery(tenantId, Object.fromEntries(nextUrl.searchParams)).cursor?.id).toBe(row.id);
    expect(deadLetterQueryReducer(next, { type: "previous" })).toEqual(query);
    expect(deadLetterQueryReducer(next, { type: "limit", limit: 20 }).cursors).toEqual([null]);
    expect(deadLetterQueryReducer(next, { type: "refresh" }).cursors).toEqual(next.cursors);
    expect(() => parseDeadLetterQuery(crypto.randomUUID(), Object.fromEntries(nextUrl.searchParams))).toThrow();
  }
});
test("archive list decoding rejects mixed tenants, duplicate IDs and malformed replay metadata", () => {
  const source = { items: [row], nextCursor: null };
  expect(readDeadLetterHistory(source, tenantId).items[0]).toEqual(row);
  for (const changed of [{ tenantId: crypto.randomUUID() }, { attemptCount: -1 }, { createdAt: "yesterday" }, { lastError: 500 }, { replay: { id: "invalid" } }]) {
    expect(() => readDeadLetterHistory({ ...source, items: [{ ...row, ...changed }] }, tenantId)).toThrow(DashboardApiError);
  }
  expect(() => readDeadLetterHistory({ items: [row, row], nextCursor: null }, tenantId)).toThrow();
  expect(readDeadLetterHistory({ items: [], nextCursor: null }, tenantId).items).toEqual([]);
  const replay = { id: receipt.replayId, eventId: receipt.eventId, createdAt: receipt.createdAt };
  expect(readDeadLetterHistory({ items: [{ ...row, replay, lastError: null }], nextCursor: null }, tenantId).items[0]?.replay).toEqual(replay);
  expect(canRequestReplay(row, true)).toBe(true);
  expect(canRequestReplay(row, false)).toBe(false);
  expect(canRequestReplay({ ...row, replay }, true)).toBe(false);
});
test("payload inspection validates all archive identities and preserves arbitrary JSON without adding an envelope", () => {
  for (const payload of [null, true, 3, "Unicode: 你好", [1, "two", null], { data: { orderId: "123", reason: "cancelled" } }]) {
    const response = { deadLetterId: row.id, tenantId, eventId: row.eventId, payload };
    expect(JSON.parse(archivedPayloadJson(response, row))).toEqual(payload);
    for (const changed of [{ tenantId: crypto.randomUUID() }, { deadLetterId: crypto.randomUUID() }, { eventId: crypto.randomUUID() }]) {
      expect(() => archivedPayloadJson({ ...response, ...changed }, row)).toThrow();
    }
  }
  expect(() => archivedPayloadJson({ deadLetterId: row.id, tenantId, eventId: row.eventId }, row)).toThrow();
  const json = JSON.stringify({ error: '<script>alert("x")</script>', value: null }, null, 2);
  const html = renderToStaticMarkup(createElement(ArchivedPayloadViewer, { json }));
  expect(html).toContain("dead-json-key"); expect(html).toContain("dead-json-string");
  expect(html).not.toContain("<script>"); expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("Copy archived payload JSON");
  const large = renderToStaticMarkup(createElement(ArchivedPayloadViewer, { json: JSON.stringify("x".repeat(160001)) }));
  expect(large).toContain("complete JSON remains available");
});
test("replay acknowledgments must match the selected source and a new event", () => {
  expect(readReplayReceipt(receipt, row)).toEqual(receipt);
  for (const changed of [{ deadLetterId: crypto.randomUUID() }, { originalEventId: crypto.randomUUID() }, { eventId: row.eventId }, { replayId: "not-an-id" }, { createdAt: "bad-date" }]) {
    expect(() => readReplayReceipt({ ...receipt, ...changed }, row)).toThrow();
  }
});
test("replay carries cookie auth, CSRF and one reusable UUID header with no payload or destination fields", async () => {
  const original = globalThis.fetch; const calls: { url: string; options?: RequestInit }[] = [];
  let status = 202; const key = crypto.randomUUID();
  globalThis.fetch = (async (url: unknown, options?: RequestInit) => { calls.push({ url: String(url), options }); return Response.json(status === 202 ? receipt : { error: "private detail" }, { status }); }) as typeof fetch;
  try {
    for (let attempt = 0; attempt < 2; attempt++) expect(await submitDeadLetterReplay("http://127.0.0.1:3000", row, "csrf", key)).toEqual(receipt);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const headers = new Headers(call.options?.headers);
      expect(call.url).toBe(`http://127.0.0.1:3000/tenants/${tenantId}/dead-letters/${row.id}/replay`);
      expect(call.options?.method).toBe("POST"); expect(call.options?.credentials).toBe("include");
      expect(headers.get("X-CSRF-Token")).toBe("csrf"); expect(headers.get("Idempotency-Key")).toBe(key);
      expect(call.options?.body).toBeUndefined(); expect(call.options?.signal).toBeDefined();
      expect(parseReplayQuery(tenantId, row.id, headers.get("Idempotency-Key"), call.options?.body, {})).toMatchObject({ idempotencyKey: key });
    }
    await expect(submitDeadLetterReplay("http://127.0.0.1:3000", row, "", key)).rejects.toMatchObject({ status: 403 });
    await expect(submitDeadLetterReplay("http://127.0.0.1:3000", row, "csrf", "bad")).rejects.toMatchObject({ status: 400 });
    await expect(requestDashboardApi("http://127.0.0.1:3000", "/auth/me", { idempotencyKey: key })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(2);
    for (const denied of [401, 403, 404, 409, 410, 502, 503]) {
      status = denied;
      await expect(submitDeadLetterReplay("http://127.0.0.1:3000", row, "csrf", key)).rejects.toMatchObject({ status: denied });
    }
  } finally { globalThis.fetch = original; }
});
test("archive errors distinguish gone payloads, missing records and replay conflicts without exposing raw server errors", () => {
  expect(deadLetterError(new DashboardApiError(410, "private"), "payload").message).toContain("no longer available");
  expect(deadLetterError(new DashboardApiError(404, "private"), "payload").message).toContain("archived record");
  expect(deadLetterError(new DashboardApiError(502, "private"), "payload").message).toContain("inspection limit");
  expect(deadLetterError(new DashboardApiError(409, "private"), "replay").message).toContain("Replay was not accepted");
});
