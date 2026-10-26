import { PrismaClient, validateBacklogCount } from "@waybill/shared";

export function outboxSamplerUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error("Outbox sampling requires a PostgreSQL DATABASE_URL");
  }
  if (!["postgresql:", "postgres:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new Error("Outbox sampling requires a PostgreSQL DATABASE_URL");
  }
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("connect_timeout", "2");
  url.searchParams.set("pool_timeout", "1");
  url.searchParams.set("socket_timeout", "5");
  return url.toString();
}

export function createOutboxBacklogReader(connectionString: string | undefined) {
  const client = new PrismaClient({ datasources: { db: { url: outboxSamplerUrl(connectionString) } } });
  return {
    async count(signal: AbortSignal): Promise<number> {
      signal.throwIfAborted();
      const rows = await client.$transaction(async tx => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '2s'`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        return tx.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM outbox WHERE published = false`;
      }, { maxWait: 1000, timeout: 4000 });
      signal.throwIfAborted();
      if (!rows[0]) throw new Error("Outbox count returned no result");
      return validateBacklogCount(Number(rows[0].count));
    },
    disconnect(): Promise<void> { return client.$disconnect(); },
  };
}
