import { PrismaClient } from "@prisma/client";
import { createReplicaReader, readReplicaUrl } from "../src/read-replica";

const replicaUrl = new URL(readReplicaUrl(process.env.READ_REPLICA_DATABASE_URL));
const primaryUrl = new URL(process.env.DATABASE_URL ?? "");
for (const url of [primaryUrl, replicaUrl]) {
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("The replication-pause test is restricted to local databases");
  }
}
if (primaryUrl.port !== "15432" || replicaUrl.port !== "15433" ||
    primaryUrl.pathname !== "/webhook_platform" || replicaUrl.pathname !== primaryUrl.pathname) {
  throw new Error("The test requires the Waybill local primary and replica ports and database");
}
primaryUrl.searchParams.set("connect_timeout", "5");
primaryUrl.searchParams.set("pool_timeout", "5");
primaryUrl.searchParams.set("socket_timeout", "10");
const adminUrl = new URL(primaryUrl);
adminUrl.port = replicaUrl.port;
const primary = new PrismaClient({ datasources: { db: { url: primaryUrl.toString() } } });
const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
const reader = createReplicaReader(replicaUrl.toString());
const id = crypto.randomUUID();
let pauseRequested = false;
let created = false;
let interrupted = false;
const stop = () => { interrupted = true; };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !interrupted) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error(interrupted ? "Replica test interrupted" : "Replica test condition timed out");
}

try {
  const state = await admin.$queryRaw<{ standby: boolean; paused: boolean }[]>`
    SELECT pg_is_in_recovery() AS standby, pg_is_wal_replay_paused() AS paused
  `;
  if (!state[0]?.standby || state[0].paused) throw new Error("Expected an unpaused local standby");
  await primary.tenant.create({ data: { id, name: "replica-before", hmacSecret: crypto.randomUUID() } });
  created = true;
  await waitFor(async () => (await reader.read(tx => tx.tenant.findUnique({ where: { id } })))?.name === "replica-before");
  console.log("Initial primary write reached the replica");

  pauseRequested = true;
  await admin.$queryRaw`SELECT pg_wal_replay_pause()::text`;
  await waitFor(async () => {
    const rows = await admin.$queryRaw<{ state: string }[]>`SELECT pg_get_wal_replay_pause_state() AS state`;
    return rows[0]?.state === "paused";
  });
  await primary.tenant.update({ where: { id }, data: { name: "replica-after" } });
  const primaryRow = await primary.tenant.findUniqueOrThrow({ where: { id } });
  const replicaRow = await reader.read(tx => tx.tenant.findUniqueOrThrow({ where: { id } }));
  if (primaryRow.name !== "replica-after" || replicaRow.name !== "replica-before") {
    throw new Error("Paused replica did not preserve the older value");
  }
  console.log("While replay was paused: primary returned the new value; replica helper returned the old value");

  let writeRejected = false;
  try {
    await reader.read(tx => tx.tenant.update({ where: { id }, data: { name: "must-not-write" } }));
  } catch (error) {
    if (!(error instanceof Error) || !/read.only|permission denied/i.test(error.message)) throw error;
    writeRejected = true;
  }
  if (!writeRejected) throw new Error("Replica accepted a write");
  console.log("Replica write was rejected");

  await admin.$queryRaw`SELECT pg_wal_replay_resume()::text`;
  pauseRequested = false;
  await waitFor(async () => (await reader.read(tx => tx.tenant.findUnique({ where: { id } })))?.name === "replica-after");
  console.log("After replay resumed: replica caught up with the primary");
} finally {
  try {
    if (pauseRequested) await admin.$queryRaw`SELECT pg_wal_replay_resume()::text`;
  } finally {
    try {
      if (created) {
        await primary.tenant.delete({ where: { id } });
        await waitFor(async () => (await reader.read(tx => tx.tenant.findUnique({ where: { id } }))) === null);
      }
    } finally {
      await Promise.all([reader.disconnect(), primary.$disconnect(), admin.$disconnect()]);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
}
console.log("Local replication and lag checks passed; test tenant removed");
