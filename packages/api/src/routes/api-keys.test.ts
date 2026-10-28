import { expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import { keyFixture } from "../testing/api-key-fixture";
import { settings } from "../testing/auth-fixture";
import { installTenantAuthorization } from "../middleware/auth";
import { createApiKeysRouter } from "./api-keys";

test("bearer authentication cannot fall back to cookies or access dashboard/key-management endpoints", async () => {
  const f = keyFixture(); const login = await f.login(); const me = await f.service.me(login.cookie);
  const app = express(); app.use(express.json()); installTenantAuthorization(app, f.service, f.keys);
  app.use(createApiKeysRouter(f.keys));
  let ingested = 0;
  app.post("/events", (_req, res) => { ingested++; res.status(201).json({ accepted: true }); });
  app.get("/tenants/:tenantId/deliveries", (_req, res) => res.json({ items: [] }));
  app.post("/tenants/:tenantId/dead-letters/:id/replay", (_req, res) => res.status(202).end());
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test address");
  const base = `http://127.0.0.1:${address.port}`;
  async function request(path: string, method: string, headers: Record<string, string>, body?: unknown) {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.text(), cache: response.headers.get("Cache-Control") };
  }
  try {
    const session = { Cookie: login.cookie, Origin: settings.webOrigin, "X-CSRF-Token": me.csrfToken };
    const created = await request(`/tenants/${f.tenantId}/api-keys`, "POST", session, { name: "integration" });
    expect(created.status).toBe(201); expect(created.cache).toBe("no-store");
    const key = JSON.parse(created.body) as { id: string; token: string };
    const bearer = { Authorization: `Bearer ${key.token}` };
    expect((await request("/events", "POST", bearer, { tenantId: f.tenantId })).status).toBe(201);
    expect((await request("/events", "POST", bearer, { tenantId: crypto.randomUUID() })).status).toBe(404);
    expect((await request("/events", "POST", { ...session, Authorization: "Bearer broken" }, { tenantId: f.tenantId })).status).toBe(401);
    for (const [path, method] of [[`/tenants/${f.tenantId}/deliveries`, "GET"], [`/tenants/${f.tenantId}/api-keys`, "GET"], [`/tenants/${f.tenantId}/api-keys`, "POST"], [`/tenants/${f.tenantId}/api-keys/${key.id}/revoke`, "POST"], [`/tenants/${f.tenantId}/dead-letters/example/replay`, "POST"]]) {
      expect((await request(path!, method!, bearer, method === "POST" ? {} : undefined)).status).toBe(401);
    }
    const listed = await request(`/tenants/${f.tenantId}/api-keys`, "GET", { Cookie: login.cookie });
    expect(listed.status).toBe(200); expect(listed.body).not.toContain(key.token); expect(listed.body).not.toContain("tokenHash");
    expect((await request(`/tenants/${f.tenantId}/api-keys/${key.id}/revoke`, "POST", session, {})).status).toBe(200);
    expect((await request("/events", "POST", bearer, { tenantId: f.tenantId })).status).toBe(401);
    const another = await f.keys.issue(login.cookie, f.tenantId, settings.webOrigin, me.csrfToken, { name: "storage error" });
    f.failKeyStorage();
    expect((await request("/events", "POST", { Authorization: `Bearer ${another.token}` }, { tenantId: f.tenantId })).status).toBe(503);
    expect(ingested).toBe(1);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
