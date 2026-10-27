import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const reseed = process.argv.includes("--reseed");
if (process.argv.slice(2).some(arg => arg !== "--reseed")) throw new Error("Use setup:replica [--reseed]");
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
ALTER SYSTEM SET max_slot_wal_keep_size = '256MB';
SELECT pg_reload_conf();
BEGIN;
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
DO $$ BEGIN
  IF to_regclass('public.auth_sessions') IS NOT NULL THEN
    REVOKE ALL ON users, tenant_memberships, auth_sessions, oauth_logins FROM waybill_reader;
  END IF;
END $$;
COMMIT;
`);
await run([...compose, "exec", "-T", "postgres", "sh", "-c", `
set -eu
rule="host replication waybill_replication samenet scram-sha-256"
if ! grep -qxF "$rule" "$PGDATA/pg_hba.conf"; then
  printf '\n%s\n' "$rule" >> "$PGDATA/pg_hba.conf"
fi
psql -v ON_ERROR_STOP=1 -U webhook -d webhook_platform -c 'SELECT pg_reload_conf()'
`]);
if (reseed) {
  await run([...compose, "stop", "postgres-replica"]);
  await run([...compose, "run", "--rm", "--no-deps", "--entrypoint", "sh", "postgres-replica", "-c", `
set -eu
if [ -d "$PGDATA" ]; then
  previous="$PGDATA.before-reseed-$(date +%Y%m%d%H%M%S)"
  test ! -e "$previous"
  mv "$PGDATA" "$previous"
  echo "Previous replica preserved at $previous"
fi
`]);
}
await run([...compose, "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "webhook", "-d", "webhook_platform"], `
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'waybill_local_replica' AND wal_status = 'lost') THEN
    IF ${reseed ? "true" : "false"} THEN
      PERFORM pg_drop_replication_slot('waybill_local_replica');
    ELSE
      RAISE EXCEPTION 'Local replication slot lost WAL; rerun setup:replica --reseed to preserve and rebuild the stale copy';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'waybill_local_replica') THEN
    PERFORM pg_create_physical_replication_slot('waybill_local_replica', true);
  END IF;
END $$;
`);
await run([...compose, "up", "-d", "--wait", "postgres-replica"]);
await run([...compose, "exec", "-T", "postgres", "sh", "-c", `
set -eu
lsn=$(psql -v ON_ERROR_STOP=1 -U webhook -d webhook_platform -Atc 'SELECT pg_current_wal_lsn()')
for attempt in $(seq 1 45); do
  caught_up=$(psql -v ON_ERROR_STOP=1 -U webhook -d webhook_platform -Atc "SELECT EXISTS (SELECT 1 FROM pg_stat_replication r JOIN pg_replication_slots s ON s.active_pid = r.pid WHERE s.slot_name = 'waybill_local_replica' AND r.state = 'streaming' AND r.replay_lsn >= '$lsn'::pg_lsn)")
  if [ "$caught_up" = "t" ]; then exit 0; fi
  sleep 1
done
echo 'Replica is running but not streaming/caught up; inspect its logs. Missing WAL requires setup:replica --reseed.' >&2
exit 1
`]);
console.log("Local replica is ready on 127.0.0.1:15433");
console.log("READ_REPLICA_DATABASE_URL=postgresql://waybill_reader:local-reader-only@127.0.0.1:15433/webhook_platform");
