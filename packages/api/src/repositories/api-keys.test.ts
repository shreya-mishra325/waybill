import { expect, test } from "bun:test";
import { createSingleConnectionPrisma, withReplicaRead, disconnectReadReplica } from "@waybill/shared";
import { apiKeyRepository, disconnectApiKeys } from "./api-keys";
import { authRepository, disconnectAuth } from "./auth";
import { createApiKeyService } from "../services/api-keys";
import { createAuthService } from "../services/auth";
import { newToken, tokenHash } from "../services/auth-tokens";

test.skipIf(process.env.RUN_AUTH_TESTS !== "1")("API keys persist hashed, revoke immediately, and disappear when creator membership is removed", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "15432") throw new Error("Local API-key database test only");
  const db = createSingleConnectionPrisma(); const githubId = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  const tenantId = crypto.randomUUID(); const sessionToken = newToken(); const csrf = newToken();
  const config = { mode: "session" as const, apiOrigin: "http://127.0.0.1:3000", webOrigin: "http://127.0.0.1:3001", secure: false, clientId: "test", clientSecret: "test" };
  const auth = createAuthService(config); const keys = createApiKeyService(auth);
  try {
    await authRepository.createSession({ githubId, githubLogin: "api-key-test" }, { tokenHash: tokenHash(sessionToken), csrfToken: csrf, expiresAt: new Date(Date.now() + 60000) });
    const user = await db.user.findUniqueOrThrow({ where: { githubId } });
    await db.tenant.create({ data: { id: tenantId, name: "api-key-test", hmacSecret: newToken() } });
    await db.tenantMembership.create({ data: { userId: user.id, tenantId } });
    const cookie = `waybill-session=${sessionToken}`;
    const key = await keys.issue(cookie, tenantId, config.webOrigin, csrf, { name: "orders", expiresInDays: 1 });
    const stored = await db.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(stored.tokenHash).toBe(tokenHash(key.token)); expect(JSON.stringify(stored)).not.toContain(key.token);
    await disconnectApiKeys();
    await createApiKeyService(auth).authorize(`Bearer ${key.token}`, tenantId);
    const listing = await keys.list(cookie, tenantId, {});
    expect(listing.items[0]?.id).toBe(key.id); expect(JSON.stringify(listing)).not.toContain("tokenHash"); expect(JSON.stringify(listing)).not.toContain(key.token);
    await keys.revoke(cookie, tenantId, key.id, config.webOrigin, csrf);
    await expect(keys.authorize(`Bearer ${key.token}`, tenantId)).rejects.toMatchObject({ status: 401 });
    const expired = await keys.issue(cookie, tenantId, config.webOrigin, csrf, { name: "expired" });
    await db.apiKey.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
    await expect(keys.authorize(`Bearer ${expired.token}`, tenantId)).rejects.toMatchObject({ status: 401 });
    const active = await keys.issue(cookie, tenantId, config.webOrigin, csrf, { name: "membership-bound" });
    await db.tenantMembership.delete({ where: { userId_tenantId: { userId: user.id, tenantId } } });
    expect(await apiKeyRepository.find(active.id)).toBeNull();
    await expect(keys.authorize(`Bearer ${active.token}`, tenantId)).rejects.toMatchObject({ status: 401 });
    await expect(withReplicaRead(tx => tx.$queryRaw`SELECT token_hash FROM api_keys LIMIT 1`)).rejects.toThrow(/permission denied/);
  } finally {
    await db.user.deleteMany({ where: { githubId } }); await db.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([db.$disconnect(), disconnectApiKeys(), disconnectAuth(), disconnectReadReplica()]);
  }
}, 30000);
