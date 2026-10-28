import { expect, test } from "bun:test";
import { keyFixture } from "../testing/api-key-fixture";
import { settings } from "../testing/auth-fixture";
import { tokenHash } from "./auth-tokens";

test("ingestion keys are tenant-scoped, hashed, expiring, and disclosed only at creation", async () => {
  const f = keyFixture(); const login = await f.login(); const me = await f.service.me(login.cookie);
  const key = await f.keys.issue(login.cookie, f.tenantId, settings.webOrigin, me.csrfToken, { name: "orders" });
  expect(key.scope).toBe("events:write");
  expect(f.rows.get(key.id)?.tokenHash).toBe(tokenHash(key.token));
  expect(JSON.stringify(await f.keys.list(login.cookie, f.tenantId, {}))).not.toContain(key.token);
  expect(JSON.stringify(await f.keys.list(login.cookie, f.tenantId, {}))).not.toContain("tokenHash");
  await f.keys.authorize(`Bearer ${key.token}`, f.tenantId);
  await expect(f.keys.authorize(`Bearer ${key.token}`, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
  await expect(f.keys.authorize(`Bearer ${key.token.slice(0, -1)}!`, f.tenantId)).rejects.toMatchObject({ status: 401 });
  const wrongSecret = key.token.slice(0, -1) + (key.token.endsWith("A") ? "B" : "A");
  await expect(f.keys.authorize(`Bearer ${wrongSecret}`, f.tenantId)).rejects.toMatchObject({ status: 401 });
  const revoked = await f.keys.revoke(login.cookie, f.tenantId, key.id, settings.webOrigin, me.csrfToken);
  expect(revoked.revokedAt).not.toBeNull();
  expect((await f.keys.revoke(login.cookie, f.tenantId, key.id, settings.webOrigin, me.csrfToken)).revokedAt).toEqual(revoked.revokedAt);
  await expect(f.keys.authorize(`Bearer ${key.token}`, f.tenantId)).rejects.toMatchObject({ status: 401 });
  const expired = await f.keys.issue(login.cookie, f.tenantId, settings.webOrigin, me.csrfToken, { name: "expired" });
  f.rows.get(expired.id)!.expiresAt = new Date(0);
  await expect(f.keys.authorize(`Bearer ${expired.token}`, f.tenantId)).rejects.toMatchObject({ status: 401 });
});

test("key management requires membership, trusted origin, CSRF, and bounded input", async () => {
  const f = keyFixture(); const login = await f.login(); const me = await f.service.me(login.cookie);
  await expect(f.keys.issue(undefined, f.tenantId, settings.webOrigin, me.csrfToken, { name: "no session" })).rejects.toMatchObject({ status: 401 });
  await expect(f.keys.issue(login.cookie, f.tenantId, "https://evil.example", me.csrfToken, { name: "bad origin" })).rejects.toMatchObject({ status: 403 });
  await expect(f.keys.issue(login.cookie, f.tenantId, settings.webOrigin, undefined, { name: "no csrf" })).rejects.toMatchObject({ status: 403 });
  for (const input of [{ name: "" }, { name: "bad", expiresInDays: 0 }, { name: "bad", expiresInDays: 366 }, { name: "bad", scope: "admin" }]) {
    await expect(f.keys.issue(login.cookie, f.tenantId, settings.webOrigin, me.csrfToken, input)).rejects.toMatchObject({ status: 400 });
  }
  const issued = [];
  for (let i = 0; i < 3; i++) issued.push(await f.keys.issue(login.cookie, f.tenantId, settings.webOrigin, me.csrfToken, { name: `key-${i}` }));
  const page = await f.keys.list(login.cookie, f.tenantId, { limit: 2 });
  expect(page.items).toHaveLength(2); expect(page.nextCursor).not.toBeNull();
  const next = await f.keys.list(login.cookie, f.tenantId, { limit: 2, cursor: page.nextCursor });
  expect(next.items).toHaveLength(1); expect(new Set([...page.items, ...next.items].map(key => key.id)).size).toBe(3);
  await expect(f.keys.list(login.cookie, f.tenantId, { cursor: crypto.randomUUID() })).rejects.toMatchObject({ status: 400 });
  f.revokeMembership();
  await expect(f.keys.issue(login.cookie, f.tenantId, settings.webOrigin, me.csrfToken, { name: "revoked user" })).rejects.toMatchObject({ status: 404 });
  expect(f.rows.size).toBe(3);
});
