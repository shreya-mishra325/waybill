import { createSingleConnectionPrisma } from "@waybill/shared";

const db = createSingleConnectionPrisma();
const metadata = { id: true, tenantId: true, createdByUserId: true, name: true, createdAt: true, expiresAt: true, revokedAt: true } as const;
export const apiKeyRepository = {
  async create(input: { id: string; tenantId: string; createdByUserId: string; name: string; tokenHash: string; expiresAt: Date }) {
    return db.apiKey.create({ data: input, select: metadata });
  },
  async find(id: string) {
    return db.apiKey.findUnique({ where: { id }, select: { tenantId: true, tokenHash: true, expiresAt: true, revokedAt: true } });
  },
  async list(tenantId: string, limit: number, cursor?: string) {
    if (cursor && !await db.apiKey.findFirst({ where: { id: cursor, tenantId }, select: { id: true } })) return null;
    return db.apiKey.findMany({ where: { tenantId }, select: metadata, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  },
  async revoke(tenantId: string, id: string, now: Date) {
    return db.$transaction(async tx => {
      await tx.apiKey.updateMany({ where: { tenantId, id, revokedAt: null }, data: { revokedAt: now } });
      return tx.apiKey.findFirst({ where: { tenantId, id }, select: metadata });
    }, { maxWait: 5000, timeout: 10000 });
  },
};
export type ApiKeyRepository = typeof apiKeyRepository;
export const disconnectApiKeys = () => db.$disconnect();
