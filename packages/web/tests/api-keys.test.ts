import { expect, test } from "bun:test";
import { DashboardApiError, requestDashboardApi } from "../src/lib/dashboard-api";
import { apiKeyError, apiKeyListPath, apiKeyQueryReducer, apiKeyStatus, createApiKey, initialApiKeyQuery, readApiKeyHistory, readApiKeyRecord, readIssuedApiKey, revokeApiKey, validateApiKeyInput, type ApiKeyRecord } from "../src/lib/api-keys";
import { keyFixture } from "../../api/src/testing/api-key-fixture";
import { settings } from "../../api/src/testing/auth-fixture";

const tenantId = "9abcde00-1234-4234-8234-123456789012";
const row: ApiKeyRecord = { id: "9abcde01-1234-4234-8234-123456789012", tenantId, createdByUserId: "user", name: "orders-service", createdAt: "2026-11-02T12:00:00.000Z", expiresAt: "2027-01-31T12:00:00.000Z", revokedAt: null, scope: "events:write" };
const fakeToken = `wb_${row.id}.${"a".repeat(43)}`;
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test("key creation validation agrees with the actual backend name and expiry rules", async () => {
  const fixture = keyFixture(); const login = await fixture.login(); const session = await fixture.service.me(login.cookie);
  for (const [name, expiry, valid] of [["  orders-service  ", "90", true], ["a".repeat(80), "1", true], ["long-lived", "365", true], [" ", "90", false], ["a".repeat(81), "90", false], ["zero", "0", false], ["too-long", "366", false], ["fraction", "1.5", false]] as const) {
    const result = validateApiKeyInput(name, expiry); expect(result.valid).toBe(valid);
    if (valid) {
      const issued = await fixture.keys.issue(login.cookie, fixture.tenantId, settings.webOrigin, session.csrfToken, result.input);
      const decoded = readIssuedApiKey(json(issued), fixture.tenantId);
      expect(decoded.key.name).toBe(name.trim()); expect(decoded.key.scope).toBe("events:write");
    } else await expect(fixture.keys.issue(login.cookie, fixture.tenantId, settings.webOrigin, session.csrfToken, result.input)).rejects.toMatchObject({ status: 400 });
  }
});
test("metadata decoding strips secrets and rejects cross-workspace or unsupported-scope responses", () => {
  const raw = { ...row, token: fakeToken, tokenHash: "private-hash" };
  expect(readApiKeyRecord(raw, tenantId)).toEqual(row);
  const list = readApiKeyHistory({ items: [raw], nextCursor: null }, tenantId);
  expect(list.items[0]).not.toHaveProperty("token"); expect(list.items[0]).not.toHaveProperty("tokenHash");
  expect(() => readApiKeyRecord({ ...row, tenantId: crypto.randomUUID() }, tenantId)).toThrow(DashboardApiError);
  expect(() => readApiKeyRecord({ ...row, scope: "admin" }, tenantId)).toThrow();
  expect(() => readApiKeyRecord({ ...row, expiresAt: "yesterday" }, tenantId)).toThrow();
  expect(() => readApiKeyHistory({ items: [row, row], nextCursor: null }, tenantId)).toThrow();
  expect(() => readApiKeyHistory({ items: [row], nextCursor: "not-a-uuid" }, tenantId)).toThrow();
  expect(readIssuedApiKey(raw, tenantId).token).toBe(fakeToken);
  expect(readIssuedApiKey(raw, tenantId).key).not.toHaveProperty("token");
  expect(() => readIssuedApiKey({ ...raw, token: `wb_${crypto.randomUUID()}.${"a".repeat(43)}` }, tenantId)).toThrow();
  expect(() => readIssuedApiKey({ ...raw, revokedAt: row.createdAt }, tenantId)).toThrow();
});
test("expired and revoked states cannot be mistaken for an active key", () => {
  const expiry = Date.parse(row.expiresAt);
  expect(apiKeyStatus(row, expiry - 1)).toBe("Active");
  expect(apiKeyStatus(row, expiry)).toBe("Expired");
  expect(apiKeyStatus(row, expiry + 1)).toBe("Expired");
  expect(apiKeyStatus({ ...row, revokedAt: row.createdAt }, expiry + 1)).toBe("Revoked");
});
test("key cursor navigation interoperates with the existing backend and resets after creation or size changes", async () => {
  const fixture = keyFixture(); const login = await fixture.login(); const session = await fixture.service.me(login.cookie);
  for (let n = 0; n < 3; n++) await fixture.keys.issue(login.cookie, fixture.tenantId, settings.webOrigin, session.csrfToken, { name: `service-${n}` });
  const firstQuery = { ...initialApiKeyQuery, limit: 1 as const };
  const firstUrl = new URL(apiKeyListPath(fixture.tenantId, firstQuery), "http://127.0.0.1");
  const first = readApiKeyHistory(json(await fixture.keys.list(login.cookie, fixture.tenantId, Object.fromEntries(firstUrl.searchParams))), fixture.tenantId);
  expect(first.items).toHaveLength(1); expect(first.nextCursor).toBe(first.items[0]!.id);
  const next = apiKeyQueryReducer(firstQuery, { type: "next", cursor: first.nextCursor! });
  const nextUrl = new URL(apiKeyListPath(fixture.tenantId, next), firstUrl.origin);
  const second = readApiKeyHistory(json(await fixture.keys.list(login.cookie, fixture.tenantId, Object.fromEntries(nextUrl.searchParams))), fixture.tenantId);
  expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  expect(apiKeyQueryReducer(next, { type: "previous" })).toEqual(firstQuery);
  expect(apiKeyQueryReducer(next, { type: "limit", limit: 20 }).cursors).toEqual([null]);
  expect(apiKeyQueryReducer(next, { type: "created" }).cursors).toEqual([null]);
  expect(apiKeyQueryReducer(next, { type: "refresh" }).cursors).toEqual(next.cursors);
  expect(readApiKeyHistory(json(await fixture.keys.list(login.cookie, fixture.tenantId, { limit: 100 })), fixture.tenantId).items).toHaveLength(3);
});
test("create sends only the supported JSON fields with cookie auth and CSRF; revoke requires confirmed matching metadata", async () => {
  const original = globalThis.fetch; const calls: { url: string; options?: RequestInit }[] = [];
  let response: unknown = { ...row, token: fakeToken }; let status = 201;
  globalThis.fetch = (async (url: unknown, options?: RequestInit) => { calls.push({ url: String(url), options }); return Response.json(response, { status }); }) as typeof fetch;
  try {
    const created = await createApiKey("http://127.0.0.1:3000", tenantId, "csrf", { name: "orders-service", expiresInDays: 90 });
    expect(created.key).not.toHaveProperty("token"); expect(created.token).toBe(fakeToken);
    const call = calls[0]!; expect(call.url).toBe(`http://127.0.0.1:3000/tenants/${tenantId}/api-keys`);
    expect(call.options?.credentials).toBe("include"); expect(call.options?.signal).toBeDefined();
    expect(new Headers(call.options?.headers).get("Content-Type")).toBe("application/json"); expect(new Headers(call.options?.headers).get("X-CSRF-Token")).toBe("csrf");
    expect(JSON.parse(String(call.options?.body))).toEqual({ name: "orders-service", expiresInDays: 90 });
    await expect(createApiKey("http://127.0.0.1:3000", tenantId, "", { name: "x", expiresInDays: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(requestDashboardApi("http://127.0.0.1:3000", "/auth/me", { body: {} })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
    status = 200; response = { ...row, revokedAt: "2026-11-02T13:00:00.000Z" };
    expect((await revokeApiKey("http://127.0.0.1:3000", row, "csrf")).revokedAt).not.toBeNull();
    expect(calls.at(-1)?.url).toBe(`http://127.0.0.1:3000/tenants/${tenantId}/api-keys/${row.id}/revoke`);
    expect(calls.at(-1)?.options?.body).toBeUndefined();
    response = row; await expect(revokeApiKey("http://127.0.0.1:3000", row, "csrf")).rejects.toThrow();
    response = { ...row, id: crypto.randomUUID(), revokedAt: row.createdAt }; await expect(revokeApiKey("http://127.0.0.1:3000", row, "csrf")).rejects.toThrow();
    for (const denied of [400, 401, 403, 404, 503]) { status = denied; await expect(createApiKey("http://127.0.0.1:3000", tenantId, "csrf", { name: "x", expiresInDays: 1 })).rejects.toMatchObject({ status: denied }); }
  } finally { globalThis.fetch = original; }
});
test("uncertain creation errors never imply success or expose server response content", () => {
  expect(apiKeyError(new DashboardApiError(0, "private"), "create").message).toContain("could not be confirmed");
  expect(apiKeyError(new DashboardApiError(503, "private"), "create").message).toContain("revoke that key");
  expect(apiKeyError(new DashboardApiError(400, "private"), "create").message).toContain("rejected");
  expect(apiKeyError(new DashboardApiError(404, "private"), "revoke").message).toContain("this workspace");
});
