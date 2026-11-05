import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

export type Policy = {
  accountId: string; startsAt: number; endsAt: number; benefitsExpireAt: number;
  minimumCreditsUsd: number; maxSqsPerHour: number; maxWritesPerHour: number; maxArchiveReadsPerHour: number;
};
export type Plan = { accountId: string; expiresAt: number; credits: number };
export type Lease = { issuedAt: number; validUntil: number; cutoff: number };
const second = 1000;
const day = 86400 * second;
const grace = 120 * second;
const leaseLife = 180 * second;
const directory = "/run/waybill-guard";
const leasePath = `${directory}/allowed.json`;
const latch = "/var/lib/waybill-guard/STOPPED";
const policyPath = "/etc/waybill/cost-policy.json";
const queries = {
  up: 'count(up{job=~"waybill-(api|publisher|worker)"} == 1)',
  timestamp: 'min(timestamp(up{job=~"waybill-(api|publisher|worker)"}))',
  sqs: 'sum(increase(waybill_sqs_operations_total[1h]))',
  writes: 'sum(increase(waybill_http_requests_total{operation=~"ingestion|replay",status_class="2xx"}[1h]))',
  archives: 'sum(increase(waybill_http_requests_total{operation="archive"}[1h]))',
} as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-data");
  return value as Record<string, unknown>;
}
function time(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("invalid-time");
  return Date.parse(value);
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("invalid-number");
  return value;
}
export function readPolicy(value: unknown): Policy {
  const raw = object(value);
  if (raw.coveredServicesVerified !== true || typeof raw.accountId !== "string" || !/^\d{12}$/.test(raw.accountId)) throw new Error("coverage-not-verified");
  const startsAt = time(raw.startsAt), endsAt = time(raw.endsAt), benefitsExpireAt = time(raw.benefitsExpireAt);
  if (endsAt <= startsAt || endsAt - startsAt > 60 * day || benefitsExpireAt <= startsAt + 3 * day) throw new Error("invalid-operating-window");
  return { accountId: raw.accountId, startsAt, endsAt, benefitsExpireAt,
    minimumCreditsUsd: number(raw.minimumCreditsUsd, 5, 10000),
    maxSqsPerHour: number(raw.maxSqsPerHour, 2000, 100000),
    maxWritesPerHour: number(raw.maxWritesPerHour, 1, 10000),
    maxArchiveReadsPerHour: number(raw.maxArchiveReadsPerHour, 1, 10000) };
}
export function readPlan(value: unknown, policy: Policy): Plan {
  const raw = object(value), credit = object(raw.accountPlanRemainingCredits);
  if (raw.accountId !== policy.accountId || raw.accountPlanType !== "FREE" || raw.accountPlanStatus !== "ACTIVE" || credit.unit !== "USD") throw new Error("unsupported-account-plan");
  return { accountId: policy.accountId, expiresAt: time(raw.accountPlanExpirationDate), credits: number(credit.amount, 0, 1000000) };
}
export function permission(policy: Policy, plan: Plan, now: number): Lease {
  const cutoff = Math.min(policy.endsAt, policy.benefitsExpireAt - 3 * day, plan.expiresAt - 3 * day);
  if (now < policy.startsAt || now >= cutoff || plan.credits <= policy.minimumCreditsUsd) throw new Error("coverage-window-or-reserve");
  return { issuedAt: now, validUntil: Math.min(now + leaseLife, cutoff), cutoff };
}
export function validLease(value: unknown, now: number): boolean {
  try {
    const raw = object(value);
    const issued = number(raw.issuedAt, 0, Number.MAX_SAFE_INTEGER);
    const until = number(raw.validUntil, 0, Number.MAX_SAFE_INTEGER);
    const cutoff = number(raw.cutoff, 0, Number.MAX_SAFE_INTEGER);
    return issued <= now + 5 * second && issued <= until && until <= issued + leaseLife && now < until && until <= cutoff;
  } catch { return false; }
}
export function healthyBackup(timestamp: number, now: number): boolean {
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now + 5 * second && now - timestamp <= 36 * 3600 * second;
}
export function healthPermission(healthy: boolean, previousBad: number | null, now: number): number | null {
  if (healthy) return null;
  const since = previousBad ?? now;
  if (!Number.isFinite(since) || since > now || now - since >= grace) throw new Error("health-grace-exhausted");
  return since;
}
export function withinUsage(policy: Policy, sqs: number, writes: number, archives: number): boolean {
  return Number.isFinite(sqs) && Number.isFinite(writes) && Number.isFinite(archives)
    && sqs >= 0 && writes >= 0 && archives >= 0
    && sqs + 120 <= policy.maxSqsPerHour && writes <= policy.maxWritesPerHour && archives <= policy.maxArchiveReadsPerHour;
}
async function bounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("response-too-large"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
async function command(args: string[], seconds: number): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), seconds * second);
  try {
    const output = await bounded(child.stdout, 32768);
    if (await child.exited !== 0) throw new Error("command-failed");
    return output;
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
}
async function metric(query: string, emptyAllowed: boolean): Promise<number> {
  const url = new URL("http://127.0.0.1:9090/api/v1/query"); url.searchParams.set("query", query);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok || !response.body) throw new Error("monitoring-unavailable");
  return readMetric(JSON.parse(await bounded(response.body, 32768)) as unknown, emptyAllowed);
}
export function readMetric(value: unknown, emptyAllowed: boolean): number {
  const raw = object(value);
  const data = object(raw.data);
  if (raw.status !== "success" || data.resultType !== "vector" || !Array.isArray(data.result)) throw new Error("invalid-monitoring");
  if (data.result.length === 0 && emptyAllowed) return 0;
  if (data.result.length !== 1) throw new Error("invalid-monitoring");
  const row = object(data.result[0]);
  if (!Array.isArray(row.value) || row.value.length !== 2 || typeof row.value[1] !== "string" || row.value[1].trim() === "") throw new Error("invalid-monitoring");
  return number(Number(row.value[1]), 0, Number.MAX_SAFE_INTEGER);
}
function secureRead(path: string): string {
  const stat = statSync(path);
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 32768 || !stat.isFile()) throw new Error("unsafe-local-file");
  return readFileSync(path, "utf8");
}
async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "lease") {
    if (!validLease(JSON.parse(secureRead(leasePath)) as unknown, Date.now())) throw new Error("expired-lease");
    return;
  }
  if (mode !== "check" && mode !== "enforce") throw new Error("invalid-mode");
  if (process.getuid?.() !== 0) throw new Error("root-required");
  if (existsSync(latch)) {
    if (mode === "enforce") return;
    throw new Error("shutdown-latched");
  }
  const now = Date.now();
  const policy = readPolicy(JSON.parse(secureRead(policyPath)) as unknown);
  if (now < policy.startsAt || now >= Math.min(policy.endsAt, policy.benefitsExpireAt - 3 * day)) throw new Error("outside-local-window");
  const backup = Number(secureRead("/var/lib/waybill-backup/success").trim()) * second;
  if (!healthyBackup(backup, now)) throw new Error("backup-not-current");
  const [planText, health, up, timestamp, sqs, writes, archives] = await Promise.all([
    command(["/usr/local/bin/aws", "freetier", "get-account-plan-state", "--region", "us-east-1", "--output", "json", "--no-cli-pager", "--cli-connect-timeout", "5", "--cli-read-timeout", "8"], 12),
    command(["/bin/bash", "/opt/waybill/current/infra/oracle/health.sh"], 25).then(() => true, () => false),
    metric(queries.up, true), metric(queries.timestamp, true), metric(queries.sqs, true), metric(queries.writes, true), metric(queries.archives, true),
  ]);
  const lease = permission(policy, readPlan(JSON.parse(planText) as unknown, policy), Date.now());
  if (!withinUsage(policy, sqs, writes, archives)) throw new Error("usage-circuit-open");
  const healthPath = `${directory}/health.json`;
  let previous: number | null = null;
  if (existsSync(healthPath)) {
    const value = object(JSON.parse(secureRead(healthPath)) as unknown).badSince;
    if (value !== null) previous = number(value, 0, Number.MAX_SAFE_INTEGER);
  }
  const badSince = healthPermission(health && up === 3 && timestamp * second >= Date.now() - 90000 && timestamp * second <= Date.now() + 5000, previous, Date.now());
  if (mode === "check") {
    if (badSince !== null) throw new Error("health-not-ready");
    console.log("Coverage, reserve, backup, health and usage checks passed."); return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  chmodSync(directory, 0o755);
  writeFileSync(healthPath, JSON.stringify({ badSince }), { mode: 0o600 });
  writeFileSync(`${leasePath}.tmp`, JSON.stringify(lease), { mode: 0o644 });
  chmodSync(`${leasePath}.tmp`, 0o644);
  renameSync(`${leasePath}.tmp`, leasePath);
}
if (import.meta.main) {
  main().catch(() => {
    if (process.argv[2] === "enforce") {
      try { unlinkSync(leasePath); } catch { /* A missing lease already denies service startup. */ }
    }
    console.error("Waybill guard denied running permission; inspect account coverage, policy, health and backup state.");
    process.exitCode = 78;
  });
}
