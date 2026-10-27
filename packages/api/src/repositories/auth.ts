import { createSingleConnectionPrisma } from "@waybill/shared";

const db = createSingleConnectionPrisma();
export const authRepository = {
  async createLogin(input: { stateHash: string; browserHash: string; codeVerifier: string; expiresAt: Date }) {
    await db.$transaction(async tx => {
      await tx.oAuthLogin.deleteMany({ where: { expiresAt: { lte: new Date() } } });
      await tx.oAuthLogin.create({ data: input });
    }, { maxWait: 5000, timeout: 10000 });
  },
  async consumeLogin(stateHash: string, browserHash: string, now: Date) {
    return db.$transaction(async tx => {
      const row = await tx.oAuthLogin.findUnique({ where: { stateHash } });
      if (!row || row.browserHash !== browserHash || row.expiresAt <= now) return null;
      const removed = await tx.oAuthLogin.deleteMany({ where: { stateHash, browserHash, expiresAt: { gt: now } } });
      return removed.count === 1 ? row : null;
    }, { maxWait: 5000, timeout: 10000 });
  },
  async createSession(identity: { githubId: string; githubLogin: string }, session: { tokenHash: string; csrfToken: string; expiresAt: Date }, previousHash?: string) {
    await db.$transaction(async tx => {
      const user = await tx.user.upsert({ where: { githubId: identity.githubId }, create: identity, update: { githubLogin: identity.githubLogin } });
      await tx.authSession.deleteMany({ where: { OR: [{ expiresAt: { lte: new Date() } }, ...(previousHash ? [{ tokenHash: previousHash }] : [])] } });
      await tx.authSession.create({ data: { ...session, userId: user.id } });
    }, { maxWait: 5000, timeout: 10000 });
  },
  async findSession(tokenHash: string, now: Date) {
    return db.authSession.findFirst({ where: { tokenHash, expiresAt: { gt: now } }, select: {
      tokenHash: true, csrfToken: true, expiresAt: true,
      user: { select: { id: true, githubId: true, githubLogin: true,
        memberships: { select: { tenant: { select: { id: true, name: true } } }, orderBy: { tenantId: "asc" } } } },
    } });
  },
  async deleteSession(tokenHash: string) { await db.authSession.deleteMany({ where: { tokenHash } }); },
};
export type AuthRepository = typeof authRepository;
export type Session = NonNullable<Awaited<ReturnType<AuthRepository["findSession"]>>>;
export const disconnectAuth = () => db.$disconnect();
