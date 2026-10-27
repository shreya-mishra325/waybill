import { expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import { createAuthRouter } from "./auth";
import { createAuthService } from "../services/auth";
import { authCors, installTenantAuthorization } from "../middleware/auth";
import { fixture, settings } from "../testing/auth-fixture";
import { newToken } from "../services/auth-tokens";

async function server(secure = false) {
  const f = fixture();
  const config = { ...settings, secure };
  const service = createAuthService(config, f.store, f.request);
  const app = express();
  app.use(express.json());
  app.use(authCors(service));
  app.use("/auth", createAuthRouter(service));
  installTenantAuthorization(app, service);
  let calls = 0;
  app.post("/events", (_req, res) => { calls++; res.status(201).json({ accepted: true }); });
  for (const path of ["deliveries", "deliveries/summary", "dead-letters", "dead-letters/:id/payload"]) {
    app.get(`/tenants/:tenantId/${path}`, (_req, res) => { calls++; res.json({ ok: true }); });
  }
  app.post("/tenants/:tenantId/dead-letters/:id/replay", (_req, res) => { calls++; res.status(202).json({ accepted: true }); });
  const http = app.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const base = `http://127.0.0.1:${address.port}`;
  const get = (path: string, init?: RequestInit) => fetch(base + path, { ...init, redirect: "manual", signal: AbortSignal.timeout(5000) });
  const close = () => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  return { ...f, get, close, calls: () => calls };
}

test("HTTP guards protect all tenant reads, archives, ingestion, and replay before downstream work", async () => {
  const f = await server();
  try {
    const login = await f.login();
    const ownPaths = ["deliveries", "deliveries/summary", "dead-letters", "dead-letters/example/payload"];
    for (const path of ownPaths) {
      expect((await f.get(`/tenants/${f.tenantId}/${path}`)).status).toBe(401);
      expect((await f.get(`/tenants/${crypto.randomUUID()}/${path}`, { headers: { Cookie: login.cookie } })).status).toBe(404);
    }
    expect((await f.get("/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantId: f.tenantId }) })).status).toBe(401);
    expect((await f.get(`/tenants/${f.tenantId}/dead-letters/example/replay`, { method: "POST" })).status).toBe(401);
    expect(f.calls()).toBe(0);
    const response = await f.get("/auth/me", { headers: { Cookie: login.cookie, Origin: settings.webOrigin } });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(settings.webOrigin);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const me = await response.json() as { csrfToken: string };
    expect(JSON.stringify(me)).not.toContain(login.token);
    for (const path of ownPaths) expect((await f.get(`/tenants/${f.tenantId}/${path}`, { headers: { Cookie: login.cookie } })).status).toBe(200);
    const body = JSON.stringify({ tenantId: f.tenantId });
    const invalidHeaders: Record<string, string>[] = [
      { Cookie: login.cookie, Origin: settings.webOrigin },
      { Cookie: login.cookie, Origin: "https://evil.example", "X-CSRF-Token": me.csrfToken },
      { Cookie: login.cookie, Origin: settings.webOrigin, "X-CSRF-Token": newToken() },
    ];
    for (const headers of invalidHeaders) expect((await f.get("/events", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body })).status).toBe(403);
    expect(f.calls()).toBe(4);
    const headers = { Cookie: login.cookie, Origin: settings.webOrigin, "X-CSRF-Token": me.csrfToken, "Content-Type": "application/json" };
    expect((await f.get("/events", { method: "POST", headers, body })).status).toBe(201);
    expect((await f.get(`/tenants/${f.tenantId}/dead-letters/example/replay`, { method: "POST", headers, body: "{}" })).status).toBe(202);
    expect((await f.get("/events", { method: "POST", headers, body: JSON.stringify({ tenantId: crypto.randomUUID() }) })).status).toBe(404);
    expect((await f.get("/auth/logout", { method: "POST", headers })).status).toBe(204);
    expect((await f.get("/auth/me", { headers: { Cookie: login.cookie } })).status).toBe(401);
  } finally { await f.close(); }
});

test("OAuth HTTP responses set private cookies, fixed redirects, and do not cache credentials", async () => {
  for (const secure of [false, true]) {
    const f = await server(secure);
    try {
      const start = await f.get("/auth/github");
      const cookie = start.headers.get("Set-Cookie")!;
      expect(start.status).toBe(302);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      expect(cookie.includes("Secure")).toBe(secure);
      expect(cookie.startsWith(secure ? "__Host-waybill-oauth=" : "waybill-oauth=")).toBe(true);
      expect(cookie).not.toContain("Domain=");
      const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
      const callback = await f.get(`/auth/github/callback?state=${state}&code=test&returnTo=https://evil.example`, { headers: { Cookie: cookie.split(";")[0]! } });
      expect(callback.status).toBe(303);
      expect(callback.headers.get("Location")).toBe(settings.webOrigin + "/");
      expect(callback.headers.get("Set-Cookie")).toContain(secure ? "__Host-waybill-session=" : "waybill-session=");
      expect(callback.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(callback.headers.get("Cache-Control")).toBe("no-store");
    } finally { await f.close(); }
  }
});

test("disallowed CORS, invalid sessions, and authentication database failures fail closed", async () => {
  const f = await server();
  try {
    expect((await f.get("/events", { method: "OPTIONS", headers: { Origin: "https://evil.example" } })).status).toBe(403);
    const allowed = await f.get("/events", { method: "OPTIONS", headers: { Origin: settings.webOrigin } });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
    expect((await f.get("/auth/me", { headers: { Cookie: `waybill-session=${newToken()}` } })).status).toBe(401);
    const login = await f.login();
    f.failDatabase();
    const unavailable = await f.get(`/tenants/${f.tenantId}/deliveries`, { headers: { Cookie: login.cookie } });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("database unavailable");
    expect(f.calls()).toBe(0);
  } finally { await f.close(); }
});
