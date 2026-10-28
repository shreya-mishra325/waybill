import type { ApiKeyRepository } from "../repositories/api-keys";
import { createApiKeyService } from "../services/api-keys";
import { fixture } from "./auth-fixture";

export function keyFixture() {
  const auth = fixture();
  type Row = Parameters<ApiKeyRepository["create"]>[0] & { createdAt: Date; revokedAt: Date | null };
  const rows = new Map<string, Row>();
  let unavailable = false;
  const publicRow = ({ tokenHash: _hash, ...row }: Row) => row;
  const store: ApiKeyRepository = {
    async create(input) { const row = { ...input, createdAt: new Date(), revokedAt: null }; rows.set(row.id, row); return publicRow(row); },
    async find(id) { if (unavailable) throw new Error("key storage unavailable"); return rows.get(id) ?? null; },
    async list(tenantId, limit, cursor) {
      const sorted = [...rows.values()].filter(row => row.tenantId === tenantId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
      const index = cursor ? sorted.findIndex(row => row.id === cursor) : -1;
      if (cursor && index === -1) return null;
      return sorted.slice(index + 1, index + 2 + limit).map(publicRow);
    },
    async revoke(tenantId, id, now) {
      const row = rows.get(id); if (!row || row.tenantId !== tenantId) return null;
      row.revokedAt ??= now; return publicRow(row);
    },
  };
  return { ...auth, rows, keyStore: store, keys: createApiKeyService(auth.service, store), failKeyStorage: () => { unavailable = true; } };
}
