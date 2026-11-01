import { expect, test } from "bun:test";
import { DashboardApiError, normalizeApiOrigin, readDashboardSession, readDeliveryHistory, readDeliverySummary, requestDashboardApi } from "../src/lib/dashboard-api";
import { deliveryLabel, formatTimestamp, selectedWorkspace } from "../src/lib/dashboard-format";

const tenantId = "9abcde00-1234-4234-8234-123456789012";
const session = { user: { id: "user", githubId: "123", githubLogin: "test-user" }, tenants: [{ id: tenantId, name: "Test workspace" }], csrfToken: "a".repeat(43), expiresAt: "2026-11-06T12:00:00.000Z" };
const summary = { total: 150, completed: 100, counts: { PENDING: 10, IN_FLIGHT: 30, SUCCEEDED: 90, FAILED: 10, DEAD_LETTERED: 10 }, successRatePercent: 90 };
const row = { id: "9abcde01-1234-4234-8234-123456789012", eventId: "9abcde02-1234-4234-8234-123456789012", tenantId, event: { type: "order.shipped" }, targetUrl: "https://example.com/webhook", status: "FAILED", attemptCount: 2, createdAt: "2026-10-30T12:00:00.000Z", lastAttemptAt: "2026-10-30T12:01:00.000Z", nextAttemptAt: null, lastError: "receiver returned 500" };

test("Overview preserves the backend's completed-delivery success rate and all real statuses", () => {
  expect(readDeliverySummary(summary).successRatePercent).toBe(90);
  expect(() => readDeliverySummary({ ...summary, successRatePercent: 60 })).toThrow(DashboardApiError);
  expect(() => readDeliverySummary({ ...summary, total: 151 })).toThrow();
  expect(() => readDeliverySummary({ ...summary, counts: { ...summary.counts, FAILED: -1 } })).toThrow();
  const empty = { total: 0, completed: 0, counts: { PENDING: 0, IN_FLIGHT: 0, SUCCEEDED: 0, FAILED: 0, DEAD_LETTERED: 0 }, successRatePercent: null };
  expect(readDeliverySummary(empty).successRatePercent).toBeNull();
  expect(() => readDeliverySummary({ ...empty, successRatePercent: 0 })).toThrow();
});
test("history decoding rejects other tenants, unknown statuses, duplicate records and invalid timestamps", () => {
  expect(readDeliveryHistory({ items: [row], nextCursor: null }, tenantId).items).toHaveLength(1);
  for (const changed of [{ tenantId: crypto.randomUUID() }, { status: "RETRYING" }, { createdAt: "yesterday" }, { nextAttemptAt: "not-a-date" }, { attemptCount: -1 }]) {
    expect(() => readDeliveryHistory({ items: [{ ...row, ...changed }], nextCursor: null }, tenantId)).toThrow();
  }
  expect(() => readDeliveryHistory({ items: [row, row], nextCursor: null }, tenantId)).toThrow();
});
test("workspace preferences grant no membership and retry labels require a scheduled retry", () => {
  const me = readDashboardSession(session);
  expect(selectedWorkspace(me, tenantId)?.name).toBe("Test workspace");
  expect(selectedWorkspace(me, crypto.randomUUID())).toBeNull();
  expect(() => readDashboardSession({ ...session, csrfToken: "" })).toThrow();
  expect(() => readDashboardSession({ ...session, tenants: [session.tenants[0], session.tenants[0]] })).toThrow();
  expect(deliveryLabel({ status: "FAILED", nextAttemptAt: null })).toBe("Failed");
  expect(deliveryLabel({ status: "FAILED", nextAttemptAt: "2026-10-30T12:00:00Z" })).toBe("Awaiting retry");
  expect(deliveryLabel({ status: "SUCCEEDED", nextAttemptAt: "2026-10-30T12:00:00Z" })).toBe("Delivered");
  expect(formatTimestamp("2026-10-30T23:30:00Z")).toEqual({ day: "30 Oct 2026", time: "23:30 UTC" });
});
test("browser API requests include credentials, protect writes and expose safe error states", async () => {
  const original = globalThis.fetch; const calls: { input: unknown; options?: RequestInit }[] = [];
  let status = 200;
  globalThis.fetch = (async (input: unknown, options?: RequestInit) => { calls.push({ input, options }); return status === 204 ? new Response(null, { status }) : Response.json(status === 200 ? session : { error: "private error detail" }, { status }); }) as typeof fetch;
  try {
    await requestDashboardApi("http://127.0.0.1:3000", "/auth/me");
    expect(calls[0]?.options?.credentials).toBe("include"); expect(calls[0]?.options?.cache).toBe("no-store");
    expect(calls[0]?.options?.signal).toBeDefined();
    await expect(requestDashboardApi("http://127.0.0.1:3000", "/auth/logout", { method: "POST" })).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
    status = 204; await requestDashboardApi("http://127.0.0.1:3000", "/auth/logout", { method: "POST", csrfToken: session.csrfToken });
    expect(new Headers(calls[1]?.options?.headers).get("X-CSRF-Token")).toBe(session.csrfToken);
    for (const denied of [401, 403, 404, 503]) {
      status = denied;
      await expect(requestDashboardApi("http://127.0.0.1:3000", "/auth/me")).rejects.toMatchObject({ status: denied });
      try { await requestDashboardApi("http://127.0.0.1:3000", "/auth/me"); } catch (error) { expect(String(error)).not.toContain("private error detail"); }
    }
    await expect(requestDashboardApi("http://127.0.0.1:3000", "//evil.example/auth/me")).rejects.toThrow();
    expect(() => normalizeApiOrigin("https://user:secret@example.com")).toThrow();
    expect(() => normalizeApiOrigin("https://api.example.com/path")).toThrow();
    expect(normalizeApiOrigin("https://api.example.com")).toBe("https://api.example.com");
  } finally { globalThis.fetch = original; }
});
