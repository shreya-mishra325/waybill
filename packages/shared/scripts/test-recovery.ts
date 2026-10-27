import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { PrismaClient, createSingleConnectionPrisma, createSqsClient, consumeTenantToken, tenantRateLimitKey,
  verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "../src/index";
import { createRedisClient, circuitKeyForTarget } from "../../worker/src/delivery/circuit-breaker";
import { readArchivedPayload } from "../../api/src/repositories/archived-payloads";
import { root, startProcess, stopProcess, health, waitFor, metric, type Child } from "./monitoring-checks";

const primaryUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(primaryUrl.hostname) || primaryUrl.port !== "15432") throw new Error("Use the local Waybill primary");
primaryUrl.searchParams.set("socket_timeout", "10");
const adminUrl = new URL(primaryUrl); adminUrl.port = "15433";
const replicaUrl = "postgresql://waybill_reader:local-reader-only@127.0.0.1:15433/webhook_platform";
const db = createSingleConnectionPrisma();
const lock = createSingleConnectionPrisma();
const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
const redis = createRedisClient();
const sqs = createSqsClient();
const runId = crypto.randomUUID();
const prefix = `phase9.recovery.${runId}.`;
const base = resolve(root, `logs/recovery-${runId}`);
const roles = ["background-0", "background-1", "background-2", "control", "limited", "probe"];
const tenants = roles.map(role => ({ id: crypto.randomUUID(), name: `phase9-${role}`, hmacSecret: crypto.randomUUID() }));
const backgroundTenants = tenants.slice(0, 3);
const control = tenants[3]!;
const limited = tenants[4]!;
const probe = tenants[5]!;
const active = new Map<string, Child>();
const children: Child[] = [];
const received = new Map<string, number>();
const effects = new Set<string>();
const successfulCalls = new Map<string, number>();
const stages: { name: string; at: number; backgroundOutstanding: number }[] = [];
const requests: { tenantId: string; type: string; status: number; eventId?: string; retryAfter: string | null }[] = [];
const errors: string[] = [];
const checkpoints: Record<string, unknown> = {};
const apiPort = 3111;
const deadId = crypto.randomUUID();
let receiver: ReturnType<typeof Bun.serve> | undefined;
let target = "";
let locked = false;
let publicationStarted = false;
let paused = false;
let replicaStopped = false;
let stopBackground = false;
let pauseBackground = false;
let posting: Promise<unknown> | undefined;
let background: Promise<void> | undefined;
let signaturesRejected = 0;
let unexpected = 0;
let passed = false;
let failure: unknown;
let trusted = new Map<string, string>();
const deadline = Date.now() + 900000;
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Recovery run interrupted"));
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);

function requireCheck(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function checkProcesses() {
  abort.signal.throwIfAborted();
  if (Date.now() > deadline) throw new Error("Recovery run exceeded 15-minute deadline");
  for (const [role, child] of active) if (child.exitCode !== null) throw new Error(`${role} exited unexpectedly`);
}
async function queueEmpty() {
  const result = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: process.env.SQS_QUEUE_URL,
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"] }),
    { abortSignal: AbortSignal.timeout(8000) });
  return (["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"] as const).every(name => result.Attributes?.[name] === "0");
}
function start(role: "api" | "publisher" | "worker" | "standby") {
  checkProcesses();
  requireCheck(!active.has(role), `${role} is already active`);
  const path = role === "api" ? "packages/api/src/index.ts" : role === "worker" ? "packages/worker/src/index.ts" : "packages/worker/src/outbox-poller.ts";
  const child = startProcess(path, { API_AUTH_MODE: "development", DATABASE_URL: primaryUrl.toString(), READ_REPLICA_DATABASE_URL: replicaUrl,
    API_PORT: String(apiPort), RECEIVER_URL: target, METRICS_ENABLED: role === "standby" ? "false" : "true", METRICS_HOST: "127.0.0.1",
    API_METRICS_PORT: "9100", PUBLISHER_METRICS_PORT: "9101", WORKER_METRICS_PORT: "9102",
    INGESTION_RATE_LIMIT_CAPACITY: "5", INGESTION_RATE_LIMIT_REFILL_PER_SECOND: "1",
    DELIVERY_RATE_LIMIT_CAPACITY: "2", DELIVERY_RATE_LIMIT_REFILL_PER_SECOND: "1", MAX_DELIVERY_ATTEMPTS: "3" }, `recovery-${runId}-${role}-${children.length}`);
  children.push(child); active.set(role, child);
  return child;
}
async function stop(role: string, crash = false) {
  const child = active.get(role); if (!child) return;
  active.delete(role);
  if (crash && child.exitCode === null) {
    child.kill("SIGKILL");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([child.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Crashed process did not exit")), 10000); })]);
    } finally { if (timer) clearTimeout(timer); }
  } else await stopProcess(child);
}
async function replicaCommand(command: "stop" | "up") {
  const args = ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.replica.yml", command];
  if (command === "up") args.push("-d", "--wait");
  args.push("postgres-replica");
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
  try {
    const [code, , error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`Replica ${command} failed: ${error}`);
  } finally { clearTimeout(timer); }
}
async function post(tenantId: string, kind: string) {
  checkProcesses();
  const type = prefix + kind;
  const response = await fetch(`http://127.0.0.1:${apiPort}/events`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, type, payload: { runId } }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
  const body = await response.json() as { eventId?: string };
  const row = { tenantId, type, status: response.status, eventId: body.eventId, retryAfter: response.headers.get("Retry-After") };
  requests.push(row);
  if (response.status !== 201 && response.status !== 429) throw new Error(`Ingestion returned ${response.status}`);
  if (response.status === 201 && !body.eventId) throw new Error("Accepted response omitted event ID");
  return row;
}
async function accept(tenantId: string, kind: string) {
  const result = await post(tenantId, kind);
  requireCheck(result.status === 201 && result.eventId, `${kind} was not accepted`);
  return result.eventId;
}
async function succeeded(eventId: string) {
  checkProcesses();
  return received.has(eventId) && Boolean(await db.delivery.findFirst({ where: { eventId, status: "SUCCEEDED" } }));
}
async function apiGet(path: string, expected = 200, allowUnavailable = false) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, { signal: AbortSignal.timeout(15000) });
  const body = await response.json() as Record<string, unknown>;
  if (allowUnavailable && response.status === 503) {
    checkpoints.replicaUnavailableReads = Number(checkpoints.replicaUnavailableReads ?? 0) + 1;
    return {};
  }
  requireCheck(response.status === expected, `Read returned ${response.status}, expected ${expected}`);
  return body;
}
async function phase(name: string) {
  checkProcesses();
  const outstanding = await db.event.count({ where: { type: { startsWith: prefix + "background" }, deliveries: { none: { status: "SUCCEEDED" } } } });
  requireCheck(outstanding >= 10, `Insufficient background pressure for ${name}`);
  stages.push({ name, at: Date.now(), backgroundOutstanding: outstanding });
  console.log(`Recovery phase: ${name}, ${outstanding} background events outstanding.`);
}
async function waitPublisherMetrics() {
  await waitFor(async () => {
    checkProcesses();
    try { return await metric(9101, "waybill_outbox_publications_total", { outcome: "published" }) > 0; }
    catch (error) { console.log("Waiting for publisher metrics:", error instanceof Error ? error.message : String(error)); return false; }
  }, "publisher metrics ready", 15000);
}
async function snapshot(label: string) {
  for (const [role, port] of [["api", 9100], ["publisher", 9101], ["worker", 9102]] as const) {
    const response = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(5000) });
    requireCheck(response.ok, `${role} metrics unavailable`);
    await Bun.write(`${base}-${label}-${role}.prom`, await response.text());
  }
}

try {
  await mkdir(resolve(root, "logs"), { recursive: true });
  await Bun.write(`${base}-manifest.json`, JSON.stringify({ runId, prefix, tenantIds: tenants.map(tenant => tenant.id),
    declaredAt: Date.now(), config: { apiAuthentication: "development", seedEvents: 90, backgroundTenants: 3, arrivalIntervalMs: 350, receiverDelayMs: 30,
      apiCapacity: 5, apiRefill: 1, dispatchCapacity: 2, dispatchRefill: 1, maxAttempts: 3, maximumDurationMs: 900000 },
    passCriteria: "At least ten unfinished background events at every fault phase; no unexpected API outcomes; signed receipts and durable outcomes for all owned work; original dead letter unchanged; one replay command; replica lag/unavailability remains isolated; failed processes recover; queue drains" }, null, 2));
  for (const port of [apiPort, 9100, 9101, 9102]) { const probeServer = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(null) }); await probeServer.stop(true); }
  const processList = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "pipe" });
  const processTimer = setTimeout(() => processList.kill("SIGKILL"), 5000);
  try {
    const [code, output, error] = await Promise.all([processList.exited, new Response(processList.stdout).text(), new Response(processList.stderr).text()]);
    requireCheck(code === 0, `Cannot inspect consumers: ${error}`);
    requireCheck(!output.split("\n").some(line => /bun.*(?:run|watch).*packages\/worker\/src\/(?:index|outbox-poller)\.ts/.test(line)), "Stop other workers and publishers before recovery testing");
  } finally { clearTimeout(processTimer); }
  const rows = await lock.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(728401) AS locked`;
  locked = rows[0]?.locked === true;
  requireCheck(locked && await queueEmpty() && await db.outbox.count({ where: { published: false } }) === 0, "Use an empty queue/outbox with no publisher");
  const state = await admin.$queryRaw<{ standby: boolean; paused: boolean }[]>`SELECT pg_is_in_recovery() AS standby, pg_is_wal_replay_paused() AS paused`;
  requireCheck(state[0]?.standby && !state[0].paused, "Expected an unpaused local standby");
  const primaryPosition = await db.$queryRaw<{ lsn: string }[]>`SELECT pg_current_wal_lsn()::text AS lsn`;
  const lsn = primaryPosition[0]!.lsn;
  await waitFor(async () => (await admin.$queryRaw<{ caughtUp: boolean }[]>`SELECT pg_last_wal_replay_lsn() >= ${lsn}::pg_lsn AS "caughtUp"`)[0]?.caughtUp === true,
    "replica catches up before generating recovery traffic", 15000);
  const sourceTenant = await db.tenant.findUniqueOrThrow({ where: { id: process.env.RECEIVER_TENANT_ID ?? "" } });
  const source = await db.event.findFirstOrThrow({ where: { tenantId: sourceTenant.id, payloadS3Key: { not: null } } });
  await readArchivedPayload(source.payloadS3Key!);
  trusted = new Map([...tenants.map(tenant => [tenant.id, tenant.hmacSecret] as const), [sourceTenant.id, sourceTenant.hmacSecret]]);
  await redis.connect();
  receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { tenantId: string; eventId: string; type: string };
      const secret = trusted.get(body.tenantId);
      if (!secret || !verifyWebhookSignature(bytes, request.headers.get(WEBHOOK_SIGNATURE_HEADER), secret)) { signaturesRejected++; return new Response("invalid signature", { status: 401 }); }
      if (!body.type.startsWith(prefix)) { unexpected++; return new Response("unexpected event", { status: 409 }); }
      const calls = (received.get(body.eventId) ?? 0) + 1;
      received.set(body.eventId, calls);
      if (body.type.startsWith(prefix + "background")) await Bun.sleep(30);
      if (body.eventId === deadId || (body.type === prefix + "retry" && calls === 1)) return new Response("controlled failure", { status: 500 });
      successfulCalls.set(body.eventId, (successfulCalls.get(body.eventId) ?? 0) + 1);
      effects.add(body.eventId);
      return new Response("ok");
    } catch (error) { unexpected++; console.error("Recovery receiver error", error); return new Response("invalid request", { status: 400 }); }
  } });
  target = new URL("/webhook", receiver.url).toString();
  await Bun.write(`${base}-receiver.json`, JSON.stringify({ target, tenantIds: [...trusted.keys()] }, null, 2));
  await db.$transaction(async tx => {
    await tx.tenant.createMany({ data: tenants });
    const seed = Array.from({ length: 90 }, (_, index) => ({ id: crypto.randomUUID(), tenantId: backgroundTenants[index % 3]!.id, type: prefix + "background.seed", payload: { runId } }));
    await tx.event.createMany({ data: seed });
    await tx.outbox.createMany({ data: seed.map(event => ({ eventId: event.id })) });
  }, { timeout: 10000 });
  start("api"); await waitFor(() => health(apiPort), "recovery API startup", 15000);
  await lock.$queryRaw`SELECT pg_advisory_unlock(728401)`; locked = false; publicationStarted = true;
  start("publisher"); start("worker");
  let sequence = 0;
  background = (async () => {
    while (!stopBackground && !abort.signal.aborted && Date.now() < deadline) {
      if (pauseBackground) { await Bun.sleep(100); continue; }
      try {
        posting = accept(backgroundTenants[sequence++ % 3]!.id, "background.http");
        await posting;
      } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); stopBackground = true; }
      finally { posting = undefined; }
      await Bun.sleep(350);
    }
  })();
  await waitPublisherMetrics();
  await phase("retry");
  const retryId = await accept(control.id, "retry");
  await waitFor(() => succeeded(retryId), "retry succeeds under background load", 90000);
  requireCheck(received.get(retryId) === 2, "Retry did not perform two calls");
  checkpoints.retryCalls = received.get(retryId);

  await phase("dead-letter and replay");
  await db.event.create({ data: { id: deadId, tenantId: sourceTenant.id, type: prefix + "dead", payloadS3Key: source.payloadS3Key, outbox: { create: {} } } });
  await waitFor(async () => { checkProcesses(); return Boolean(await db.deadLetter.findFirst({ where: { eventId: deadId } })); }, "archive-backed dead letter", 120000);
  const dead = await db.deadLetter.findFirstOrThrow({ where: { eventId: deadId } });
  const failed = await db.delivery.findUniqueOrThrow({ where: { id: dead.deliveryId } });
  requireCheck(failed.status === "DEAD_LETTERED" && failed.attemptCount === 3 && received.get(deadId) === 3 && dead.payloadS3Key === source.payloadS3Key, "Invalid exhausted-delivery state");
  const key = crypto.randomUUID();
  const replayPath = `/tenants/${sourceTenant.id}/dead-letters/${dead.id}/replay`;
  async function replay() {
    const response = await fetch(`http://127.0.0.1:${apiPort}${replayPath}`, { method: "POST", headers: { "Idempotency-Key": key, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30000) });
    const body = await response.json() as { eventId?: string };
    requireCheck(response.status === 202 && body.eventId, `Replay returned ${response.status}`);
    return body.eventId;
  }
  const replayIds = await Promise.all(Array.from({ length: 10 }, replay));
  requireCheck(new Set(replayIds).size === 1, "Concurrent replay created multiple identities");
  const replayId = replayIds[0]!;
  await waitFor(() => succeeded(replayId), "replay delivery under load", 90000);
  requireCheck(await db.replay.count({ where: { sourceDeadLetterId: dead.id } }) === 1, "More than one replay audit command");
  checkpoints.replayRequests = replayIds.length; checkpoints.replayEvents = 1; checkpoints.deadAttempts = failed.attemptCount;

  await phase("ingestion and dispatch rate limits");
  const burst = await Promise.all(Array.from({ length: 25 }, () => post(limited.id, "limited")));
  requireCheck(burst.some(row => row.status === 201) && burst.some(row => row.status === 429) && burst.every(row => row.status !== 429 || Number(row.retryAfter) >= 1), "Missing rate-limit rejection or Retry-After");
  await accept(probe.id, "other-tenant-budget");
  const deferralsBefore = await metric(9102, "waybill_delivery_deferrals_total", { reason: "rate_limit" });
  await consumeTenantToken(redis, control.id, "delivery", { capacity: 2, refillPerSecond: 1 });
  await consumeTenantToken(redis, control.id, "delivery", { capacity: 2, refillPerSecond: 1 });
  const dispatch = await Promise.all([accept(control.id, "dispatch"), accept(control.id, "dispatch")]);
  await waitFor(async () => (await Promise.all(dispatch.map(succeeded))).every(Boolean), "dispatch deferral recovery", 90000);
  requireCheck(await metric(9102, "waybill_delivery_deferrals_total", { reason: "rate_limit" }) > deferralsBefore, "No dispatch rate-limit deferral observed");
  checkpoints.ingestionAccepted = burst.filter(row => row.status === 201).length;
  checkpoints.ingestionRejected = burst.filter(row => row.status === 429).length;

  await phase("replica reads and controlled lag");
  await waitFor(async () => {
    const summary = await apiGet(`/tenants/${probe.id}/deliveries/summary`);
    return Number(summary.total) >= 1;
  }, "initial replica read", 30000);
  paused = true; await admin.$queryRaw`SELECT pg_wal_replay_pause()::text`;
  await waitFor(async () => (await admin.$queryRaw<{ state: string }[]>`SELECT pg_get_wal_replay_pause_state() AS state`)[0]?.state === "paused", "replica pause", 10000);
  const frozen = await apiGet(`/tenants/${probe.id}/deliveries/summary`);
  const lagId = await accept(probe.id, "lag-probe");
  await waitFor(() => succeeded(lagId), "primary delivery while replica paused", 90000);
  const stillFrozen = await apiGet(`/tenants/${probe.id}/deliveries/summary`);
  requireCheck(JSON.stringify(frozen) === JSON.stringify(stillFrozen), "Paused replica showed primary writes");
  await admin.$queryRaw`SELECT pg_wal_replay_resume()::text`; paused = false;
  await waitFor(async () => Number((await apiGet(`/tenants/${probe.id}/deliveries/summary`, 200, true)).total) === Number(frozen.total) + 1, "replica catches up", 30000);
  await apiGet(`/tenants/${probe.id}/dead-letters/${dead.id}/payload`, 404);
  const history = await apiGet(`/tenants/${probe.id}/deliveries?limit=100`);
  requireCheck(Array.isArray(history.items) && history.items.every((row: { tenantId?: string }) => row.tenantId === probe.id), "Replica history leaked another tenant");
  checkpoints.replicaLagVerified = true;

  await phase("replica unavailability");
  replicaStopped = true; await replicaCommand("stop");
  await apiGet(`/tenants/${probe.id}/deliveries/summary`, 503);
  const unavailableId = await accept(probe.id, "replica-unavailable");
  await waitFor(() => succeeded(unavailableId), "ingestion and delivery while replica stopped", 90000);
  await replicaCommand("up"); replicaStopped = false;
  await waitFor(async () => Number((await apiGet(`/tenants/${probe.id}/deliveries/summary`, 200, true)).total) === Number(frozen.total) + 2, "replica restart catch-up", 30000);
  checkpoints.replicaOutageIsolated = true;

  await phase("API restart and durable replay key");
  pauseBackground = true; await posting;
  await stop("api"); start("api"); await waitFor(() => health(apiPort), "API restart", 15000);
  requireCheck(await replay() === replayId, "API restart lost replay identity");
  pauseBackground = false;
  checkpoints.replaySurvivedApiRestart = true;

  await phase("publisher crash and standby takeover");
  const standby = start("standby");
  await Bun.sleep(2500);
  requireCheck(standby.exitCode === null, "Standby exited");
  await stop("publisher", true);
  const takeoverId = await accept(probe.id, "publisher-takeover");
  await waitFor(() => succeeded(takeoverId), "standby publishes after leader crash", 90000);
  await stop("standby"); start("publisher"); await waitPublisherMetrics();
  checkpoints.publisherTakeoverVerified = true;

  await phase("worker crash and visibility recovery");
  await snapshot("before-worker-crash");
  await waitFor(async () => await metric(9102, "waybill_buffered_reservations") > 0, "owned worker reservations before crash", 30000);
  const successesBefore = await db.delivery.count({ where: { tenantId: { in: backgroundTenants.map(tenant => tenant.id) }, status: "SUCCEEDED" } });
  await stop("worker", true); start("worker");
  await waitFor(async () => { checkProcesses(); return await db.delivery.count({ where: { tenantId: { in: backgroundTenants.map(tenant => tenant.id) }, status: "SUCCEEDED" } }) > successesBefore; }, "worker resumes queued work", 90000);
  checkpoints.workerCrashRecovered = true;
  stopBackground = true; await background;
  requireCheck(errors.length === 0, "Background requests had uncertain or rejected outcomes");
  const finalOriginal = await db.delivery.findUniqueOrThrow({ where: { id: failed.id } });
  requireCheck(finalOriginal.status === "DEAD_LETTERED" && finalOriginal.attemptCount === 3, "Recovery changed original failure history");
  await waitFor(async () => {
    checkProcesses();
    const events = await db.event.findMany({ where: { type: { startsWith: prefix } }, select: { id: true, deliveries: { select: { status: true } } } });
    return events.every(event => event.deliveries.length === 1 && event.deliveries[0]?.status === (event.id === deadId ? "DEAD_LETTERED" : "SUCCEEDED"));
  }, "all recovery traffic reaches expected durable outcomes", 600000);
  let empty = 0;
  await waitFor(async () => { await Bun.sleep(1500); checkProcesses(); empty = await queueEmpty() && await db.outbox.count({ where: { published: false } }) === 0 ? empty + 1 : 0; return empty >= 2; }, "recovery queue drain", 90000);
  await waitFor(async () => {
    checkProcesses();
    const prom = await fetch('http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D~%22waybill-(api%7Cpublisher%7Cworker)%22%2Cverification!%3D%22true%22%7D', { signal: AbortSignal.timeout(5000) });
    requireCheck(prom.ok, "Prometheus query unavailable");
    const targets = await prom.json() as { data: { result: { value: [number, string] }[] } };
    return targets.data.result.length === 3 && targets.data.result.every(row => row.value[1] === "1");
  }, "monitoring targets recover after process restarts", 45000);
  await snapshot("final");
  const allEvents = await db.event.findMany({ where: { type: { startsWith: prefix } }, select: { id: true } });
  requireCheck(allEvents.every(event => received.has(event.id)) && effects.size === allEvents.length - 1 && signaturesRejected === 0 && unexpected === 0, "Missing receipt, unexpected payload, or invalid signature");
  checkpoints.totalEvents = allEvents.length; checkpoints.successfulEffects = effects.size;
  checkpoints.repeatedCallsIncludingRetries = [...received.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  checkpoints.duplicateSuccessfulCalls = [...successfulCalls.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  checkpoints.backgroundHttpAccepted = requests.filter(row => row.type.startsWith(prefix + "background") && row.status === 201).length;
  checkpoints.seedEvents = 90;
  checkpoints.originalDeadLetterRetained = true;
  passed = true;
} catch (error) { failure = error; }
finally {
  stopBackground = true; await background;
  try {
    if (replicaStopped) await replicaCommand("up");
    if (paused) await admin.$queryRaw`SELECT pg_wal_replay_resume()::text`;
  } catch (error) { failure ??= error; passed = false; }
  const stopped = await Promise.allSettled(children.map(stopProcess));
  if (stopped.some(result => result.status === "rejected")) { failure ??= new Error("Could not stop every owned process"); passed = false; }
  try {
    if (passed || !publicationStarted) {
      const events = await db.event.findMany({ where: { type: { startsWith: prefix } }, select: { id: true } });
      const ids = events.map(event => event.id);
      await db.$transaction(async tx => {
        await tx.replay.deleteMany({ where: { eventId: { in: ids } } });
        await tx.outbox.deleteMany({ where: { eventId: { in: ids } } });
        await tx.deadLetter.deleteMany({ where: { eventId: { in: ids } } });
        await tx.delivery.deleteMany({ where: { eventId: { in: ids } } });
        await tx.event.deleteMany({ where: { id: { in: ids } } });
        await tx.tenant.deleteMany({ where: { id: { in: tenants.map(tenant => tenant.id) } } });
      }, { timeout: 10000 });
      if (redis.status === "ready") await redis.del(...tenants.flatMap(tenant => [tenantRateLimitKey(tenant.id, "ingestion"), tenantRateLimitKey(tenant.id, "delivery")]), ...(target ? [circuitKeyForTarget(target)] : []));
    } else console.error(`Recovery check incomplete; owned work preserved: ${prefix}`);
  } catch (error) { failure ??= error; passed = false; }
  try { if (locked) await lock.$queryRaw`SELECT pg_advisory_unlock(728401)`; }
  catch (error) { failure ??= error; passed = false; }
  redis.disconnect();
  await Promise.all([receiver?.stop(true), db.$disconnect(), lock.$disconnect(), admin.$disconnect()]);
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  await Bun.write(`${base}-requests.json`, JSON.stringify(requests, null, 2));
  await Bun.write(`${base}-receipts.json`, JSON.stringify([...received], null, 2));
  await Bun.write(`${base}-result.json`, JSON.stringify({ runId, prefix, passed, failure: failure instanceof Error ? failure.message : failure ? String(failure) : null,
    checkpoints, stages, errors, signaturesRejected, unexpected, finishedAt: Date.now(),
    caveats: "API and worker counters reset on restart; durable database outcomes are authoritative. Seed work enters through a declared database/outbox fixture; subsequent background traffic uses HTTP. Receiver deduplication is in-memory for this run." }, null, 2));
}
if (!passed) throw failure ?? new Error("Recovery checks did not pass");
console.log(JSON.stringify({ runId, passed, checkpoints, stages }));
