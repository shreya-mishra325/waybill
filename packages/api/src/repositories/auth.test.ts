import { expect, test } from "bun:test";
import { createSingleConnectionPrisma, withReplicaRead, disconnectReadReplica } from "@waybill/shared";
import { authRepository, disconnectAuth } from "./auth";
import { createAuthService } from "../services/auth";
import { newToken, tokenHash } from "../services/auth-tokens";

const enabled = process.env.RUN_AUTH_TESTS === "1";
test.skipIf(!enabled)("auth persistence consumes state once, survives service restart, and applies immediate access revocation", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "15432" || url.pathname !== "/webhook_platform") {
    throw new Error("Authentication integration tests require the local Waybill primary");
  }
  const db = createSingleConnectionPrisma();
  const githubId = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  const tenantId = crypto.randomUUID();
  const state = newToken();
  const browser = newToken();
  const token = newToken();
  const csrfToken = newToken();
  const settings = { mode: "session" as const, apiOrigin: "http://127.0.0.1:3000", webOrigin: "http://127.0.0.1:3001",
    secure: false, clientId: "test-only", clientSecret: "test-only" };
  try {
    const access = await withReplicaRead(tx => tx.$queryRaw<{ protected: boolean }[]>`
      SELECT NOT (has_table_privilege(current_user, 'public.users', 'SELECT')
        OR has_table_privilege(current_user, 'public.tenant_memberships', 'SELECT')
        OR has_table_privilege(current_user, 'public.auth_sessions', 'SELECT')
        OR has_table_privilege(current_user, 'public.oauth_logins', 'SELECT')) AS protected
    `);
    expect(access[0]?.protected).toBe(true);
    await expect(withReplicaRead(tx => tx.$queryRaw`SELECT token_hash FROM auth_sessions LIMIT 1`)).rejects.toThrow(/permission denied/);
    await authRepository.createLogin({ stateHash: tokenHash(state), browserHash: tokenHash(browser), codeVerifier: newToken(), expiresAt: new Date(Date.now() + 60000) });
    const attempts = await Promise.all(Array.from({ length: 5 }, () => authRepository.consumeLogin(tokenHash(state), tokenHash(browser), new Date())));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await db.oAuthLogin.count({ where: { stateHash: tokenHash(state) } })).toBe(0);
    await authRepository.createSession({ githubId, githubLogin: "auth-test" }, { tokenHash: tokenHash(token), csrfToken, expiresAt: new Date(Date.now() + 60000) });
    const user = await db.user.findUniqueOrThrow({ where: { githubId } });
    expect(await db.authSession.findUnique({ where: { tokenHash: token } })).toBeNull();
    const initial = createAuthService(settings);
    const cookie = `waybill-session=${token}`;
    expect((await initial.me(cookie)).tenants).toHaveLength(0);
    await expect(initial.authorize(cookie, tenantId, "GET")).rejects.toMatchObject({ status: 404 });
    await db.tenant.create({ data: { id: tenantId, name: "auth-test", hmacSecret: newToken() } });
    await db.tenantMembership.create({ data: { tenantId, userId: user.id } });
    await disconnectAuth();
    const restarted = createAuthService(settings);
    expect((await restarted.me(cookie)).tenants).toEqual([{ id: tenantId, name: "auth-test" }]);
    expect((await restarted.authorize(cookie, tenantId, "POST", settings.webOrigin, csrfToken)).user.id).toBe(user.id);
    await db.tenantMembership.deleteMany({ where: { tenantId, userId: user.id } });
    await expect(restarted.authorize(cookie, tenantId, "GET")).rejects.toMatchObject({ status: 404 });
    await restarted.logout(cookie, settings.webOrigin, csrfToken);
    await expect(restarted.me(cookie)).rejects.toMatchObject({ status: 401 });
    expect(await db.authSession.count({ where: { userId: user.id } })).toBe(0);
    await authRepository.createLogin({ stateHash: tokenHash(state), browserHash: tokenHash(browser), codeVerifier: newToken(), expiresAt: new Date(0) });
    expect(await authRepository.consumeLogin(tokenHash(state), tokenHash(browser), new Date())).toBeNull();
    await authRepository.createSession({ githubId, githubLogin: "renamed-auth-test" }, { tokenHash: tokenHash(token), csrfToken, expiresAt: new Date(0) });
    await expect(restarted.me(cookie)).rejects.toMatchObject({ status: 401 });
    expect((await db.user.findUniqueOrThrow({ where: { githubId } })).id).toBe(user.id);
  } finally {
    await db.oAuthLogin.deleteMany({ where: { stateHash: tokenHash(state) } });
    await db.user.deleteMany({ where: { githubId } });
    await db.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([db.$disconnect(), disconnectAuth(), disconnectReadReplica()]);
  }
}, 30000);
