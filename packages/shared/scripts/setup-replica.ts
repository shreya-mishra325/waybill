import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const compose = ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.replica.yml"];

async function run(args: string[], input?: string): Promise<void> {
  const process = Bun.spawn(args, {
    cwd: root,
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "inherit",
    stderr: "inherit",
  });
  const timer = setTimeout(() => process.kill("SIGTERM"), 120_000);
  try {
    if (await process.exited !== 0) throw new Error("Local replica setup command failed");
  } finally {
    clearTimeout(timer);
  }
}

await run([...compose, "up", "-d", "--wait", "postgres"]);
await run([...compose, "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "webhook", "-d", "webhook_platform"], `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waybill_replication') THEN
    CREATE ROLE waybill_replication LOGIN REPLICATION PASSWORD 'local-replication-only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waybill_reader') THEN
    CREATE ROLE waybill_reader LOGIN PASSWORD 'local-reader-only';
  END IF;
END $$;
GRANT CONNECT ON DATABASE webhook_platform TO waybill_reader;
GRANT USAGE ON SCHEMA public TO waybill_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO waybill_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE webhook IN SCHEMA public GRANT SELECT ON TABLES TO waybill_reader;
`);
await run([...compose, "exec", "-T", "postgres", "sh", "-c", `
set -eu
rule="host replication waybill_replication samenet scram-sha-256"
if ! grep -qxF "$rule" "$PGDATA/pg_hba.conf"; then
  printf '\n%s\n' "$rule" >> "$PGDATA/pg_hba.conf"
fi
psql -v ON_ERROR_STOP=1 -U webhook -d webhook_platform -c 'SELECT pg_reload_conf()'
`]);
await run([...compose, "up", "-d", "--wait", "postgres-replica"]);
console.log("Local replica is ready on 127.0.0.1:15433");
console.log("READ_REPLICA_DATABASE_URL=postgresql://waybill_reader:local-reader-only@127.0.0.1:15433/webhook_platform");
