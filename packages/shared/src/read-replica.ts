import { PrismaClient, type Prisma } from "@prisma/client";

export function readReplicaUrl(value: string | undefined): string {
  if (!value?.trim()) throw new Error("READ_REPLICA_DATABASE_URL is required for dashboard reads");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("READ_REPLICA_DATABASE_URL must be a PostgreSQL connection URL");
  }
  if (!["postgresql:", "postgres:"].includes(url.protocol) || !url.hostname || url.pathname.length <= 1) {
    throw new Error("READ_REPLICA_DATABASE_URL must identify a PostgreSQL database");
  }
  url.searchParams.set("connect_timeout", "5");
  url.searchParams.set("pool_timeout", "5");
  url.searchParams.set("socket_timeout", "10");
  return url.toString();
}

export function createReplicaReader(connectionString: string | undefined) {
  const client = new PrismaClient({
    datasources: { db: { url: readReplicaUrl(connectionString) } },
  });

  return {
    read<T>(query: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
      return client.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const rows = await tx.$queryRaw<{ inRecovery: boolean }[]>`
          SELECT pg_is_in_recovery() AS "inRecovery"
        `;
        if (rows[0]?.inRecovery !== true) {
          throw new Error("Dashboard reads require a PostgreSQL standby; the configured server is not a replica");
        }
        return query(tx);
      }, { maxWait: 5000, timeout: 10_000 });
    },
    disconnect(): Promise<void> {
      return client.$disconnect();
    },
  };
}

let reader: ReturnType<typeof createReplicaReader> | undefined;

export function withReplicaRead<T>(query: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  reader ??= createReplicaReader(process.env.READ_REPLICA_DATABASE_URL);
  return reader.read(query);
}

export async function disconnectReadReplica(): Promise<void> {
  if (!reader) return;
  await reader.disconnect();
  reader = undefined;
}
