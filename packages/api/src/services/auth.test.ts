import { describe, expect, test } from "bun:test";
import { authConfig } from "./auth-config";
import { createAuthService } from "./auth";
import { cookieToken, newToken, tokenHash } from "./auth-tokens";
import { fixture, settings } from "../testing/auth-fixture";

describe("authentication configuration", () => {
  test("forbids production bypass and requires complete HTTPS configuration", () => {
    expect(() => authConfig({ NODE_ENV: "production", API_AUTH_MODE: "development" })).toThrow();
    expect(() => authConfig({ NODE_ENV: "production" })).toThrow();
    expect(() => authConfig({ API_AUTH_MODE: "unknown" })).toThrow();
    expect(authConfig({})).toEqual({ mode: "development" });
    const env = { NODE_ENV: "production", API_AUTH_MODE: "session", AUTH_API_ORIGIN: "https://api.example.com",
      AUTH_WEB_ORIGIN: "https://app.example.com", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" };
    expect(authConfig(env)).toMatchObject({ mode: "session", secure: true });
    for (const invalid of ["http://example.com", "https://name:password@example.com", "https://api.example.com/path", "https://api.example.com?code=secret"]) {
      expect(() => authConfig({ ...env, AUTH_API_ORIGIN: invalid })).toThrow();
    }
  });
});

describe("GitHub sign-in and sessions", () => {
  test("uses browser-bound one-time state, PKCE, hashed session tokens, and session rotation", async () => {
    const f = fixture();
    const first = await f.login();
    const url = new URL(first.begin.url);
    expect(url.origin).toBe("https://github.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(Buffer.from(tokenHash(f.lastVerifier()), "hex").toString("base64url"));
    expect(url.searchParams.get("scope")).toBe("");
    expect(url.toString()).not.toContain(settings.clientSecret);
    expect(f.sessions.has(first.token)).toBe(false);
    expect(f.sessions.has(tokenHash(first.token))).toBe(true);
    await expect(f.service.complete({ state: first.state, code: "code" }, `waybill-oauth=${first.begin.browser}`)).rejects.toMatchObject({ status: 400 });
    const second = await f.login(first.token);
    await expect(f.service.me(first.cookie)).rejects.toMatchObject({ status: 401 });
    expect((await f.service.me(second.cookie)).user.githubId).toBe("12345");
    const restarted = createAuthService(settings, f.store, f.request);
    expect((await restarted.me(second.cookie)).tenants).toEqual([{ id: f.tenantId, name: "owned" }]);
  });
  test("rejects mismatched, expired, duplicate, and malformed callbacks before contacting GitHub", async () => {
    const f = fixture();
    const begin = await f.service.begin();
    const state = new URL(begin.url).searchParams.get("state")!;
    await expect(f.service.complete({ state, code: "code" }, `waybill-oauth=${newToken()}`)).rejects.toMatchObject({ status: 400 });
    await expect(f.service.complete({ state: [state, state], code: "code" }, `waybill-oauth=${begin.browser}`)).rejects.toMatchObject({ status: 400 });
    f.logins.get(tokenHash(state))!.expiresAt = new Date(0);
    await expect(f.service.complete({ state, code: "code" }, `waybill-oauth=${begin.browser}`)).rejects.toMatchObject({ status: 400 });
    expect(f.githubRequests()).toBe(0);
    expect(cookieToken(`waybill-session=${newToken()}; waybill-session=${newToken()}`, "waybill-session")).toBeUndefined();
  });
  test("only one concurrent callback consumes a login attempt", async () => {
    const f = fixture();
    const begin = await f.service.begin();
    const query = { state: new URL(begin.url).searchParams.get("state"), code: "code" };
    const results = await Promise.allSettled([f.service.complete(query, `waybill-oauth=${begin.browser}`), f.service.complete(query, `waybill-oauth=${begin.browser}`)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(f.sessions.size).toBe(1);
  });
  test("provider failure creates no session and cannot reuse the consumed state", async () => {
    const f = fixture();
    const failed = createAuthService(settings, f.store, (async () => Response.json({ error: "bad_verification_code" })) as unknown as typeof fetch);
    const begin = await failed.begin();
    const query = { state: new URL(begin.url).searchParams.get("state"), code: "code" };
    await expect(failed.complete(query, `waybill-oauth=${begin.browser}`)).rejects.toMatchObject({ status: 502 });
    await expect(failed.complete(query, `waybill-oauth=${begin.browser}`)).rejects.toMatchObject({ status: 400 });
    expect(f.sessions.size).toBe(0);
  });
  test("checks membership immediately, requires CSRF for writes, and revokes logout/expired sessions", async () => {
    const f = fixture();
    const login = await f.login();
    const me = await f.service.me(login.cookie);
    await expect(f.service.authorize(login.cookie, crypto.randomUUID(), "GET")).rejects.toMatchObject({ status: 404 });
    await expect(f.service.authorize(login.cookie, f.tenantId, "POST", "https://evil.example", me.csrfToken)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.authorize(login.cookie, f.tenantId, "POST", settings.webOrigin, newToken())).rejects.toMatchObject({ status: 403 });
    expect((await f.service.authorize(login.cookie, f.tenantId, "POST", settings.webOrigin, me.csrfToken)).user.githubId).toBe("12345");
    f.revokeMembership();
    await expect(f.service.authorize(login.cookie, f.tenantId, "GET")).rejects.toMatchObject({ status: 404 });
    await f.service.logout(login.cookie, settings.webOrigin, me.csrfToken);
    await expect(f.service.me(login.cookie)).rejects.toMatchObject({ status: 401 });
    const next = await f.login();
    f.sessions.get(tokenHash(next.token))!.expiresAt = new Date(0);
    await expect(f.service.me(next.cookie)).rejects.toMatchObject({ status: 401 });
  });
});
