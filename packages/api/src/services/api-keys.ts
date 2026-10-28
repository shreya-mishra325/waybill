import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { apiKeyRepository, type ApiKeyRepository } from "../repositories/api-keys";
import { AuthError, type AuthService } from "./auth";
import { newToken, tokenHash } from "./auth-tokens";

const issueSchema = z.object({ name: z.string().trim().min(1).max(80), expiresInDays: z.number().int().min(1).max(365).default(90) }).strict();
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().uuid().optional() }).strict();
const bearerPattern = /^Bearer (wb_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43})$/i;
export const INGESTION_SCOPE = "events:write";

export function createApiKeyService(auth: AuthService, store: ApiKeyRepository = apiKeyRepository) {
  return {
    async authorize(header: string, tenantId: unknown) {
      const match = bearerPattern.exec(header);
      if (!match) throw new AuthError(401, "Invalid API key");
      const key = await store.find(match[2]!);
      const candidate = tokenHash(match[1]!);
      if (!key || key.revokedAt || key.expiresAt <= new Date() || !/^[a-f0-9]{64}$/.test(key.tokenHash) ||
          !timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(key.tokenHash, "hex"))) throw new AuthError(401, "Invalid or expired API key");
      const parsed = z.string().uuid().safeParse(tenantId);
      if (!parsed.success) throw new AuthError(400, "Invalid tenant ID");
      if (parsed.data !== key.tenantId) throw new AuthError(404, "Tenant not found");
    },
    async issue(cookie: string | undefined, tenantId: string, origin: string | undefined, csrf: string | undefined, input: unknown) {
      const session = await auth.authorize(cookie, tenantId, "POST", origin, csrf);
      const parsed = issueSchema.safeParse(input);
      if (!parsed.success) throw new AuthError(400, "Supply a key name and an optional expiry of 1 to 365 days");
      const id = crypto.randomUUID();
      const token = `wb_${id}.${newToken()}`;
      const key = await store.create({ id, tenantId, createdByUserId: session.user.id, name: parsed.data.name,
        tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + parsed.data.expiresInDays * 86400000) });
      return { ...key, scope: INGESTION_SCOPE, token };
    },
    async list(cookie: string | undefined, tenantId: string, query: unknown) {
      await auth.authorize(cookie, tenantId, "GET");
      const parsed = listSchema.safeParse(query);
      if (!parsed.success) throw new AuthError(400, "Invalid API key list query");
      const rows = await store.list(tenantId, parsed.data.limit, parsed.data.cursor);
      if (!rows) throw new AuthError(400, "Invalid API key cursor");
      const items = rows.slice(0, parsed.data.limit).map(key => ({ ...key, scope: INGESTION_SCOPE }));
      return { items, nextCursor: rows.length > parsed.data.limit ? items.at(-1)!.id : null };
    },
    async revoke(cookie: string | undefined, tenantId: string, id: string, origin: string | undefined, csrf: string | undefined) {
      await auth.authorize(cookie, tenantId, "POST", origin, csrf);
      if (!z.string().uuid().safeParse(id).success) throw new AuthError(400, "Invalid API key ID");
      const key = await store.revoke(tenantId, id, new Date());
      if (!key) throw new AuthError(404, "API key not found");
      return { ...key, scope: INGESTION_SCOPE };
    },
  };
}
export type ApiKeyService = ReturnType<typeof createApiKeyService>;
