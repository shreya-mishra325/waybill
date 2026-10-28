import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { createSingleConnectionPrisma, createSqsClient, verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER, tenantRateLimitKey } from "../src/index";
import { authRepository, disconnectAuth } from "../../api/src/repositories/auth";
import { newToken, tokenHash } from "../../api/src/services/auth-tokens";
import { readArchivedPayload } from "../../api/src/repositories/archived-payloads";
import { createRedisClient, circuitKeyForTarget } from "../../worker/src/delivery/circuit-breaker";
import { root, startProcess, stopProcess, health, waitFor, type Child } from "./monitoring-checks";

const primary = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(primary.hostname) || primary.port !== "15432") throw new Error("Authenticated flow requires the local Waybill primary");
const runId = crypto.randomUUID();
const prefix = `auth.flow.${runId}.`;
const base = resolve(root, `logs/auth-flow-${runId}`);
const db = createSingleConnectionPrisma(); const lock = createSingleConnectionPrisma(); const sqs = createSqsClient();
const redis = createRedisClient();
const tenants = [0, 1].map(index => ({ id: crypto.randomUUID(), name: `auth-flow-${index}`, hmacSecret: newToken() }));
const tenant = tenants[0]!; const other = tenants[1]!;
const githubId = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
const sessionToken = newToken(); const csrf = newToken(); const cookie = `waybill-session=${sessionToken}`;
const port = 3113; const api = `http://127.0.0.1:${port}`; const origin = "http://127.0.0.1:3001";
const sessionHeaders = { Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf };
const children: Child[] = []; const receipts = new Map<string, number>();
const checks: Record<string, unknown> = {}; const deadId = crypto.randomUUID();
let receiver: ReturnType<typeof Bun.serve> | undefined; let target = "";
let locked = false; let publicationStarted = false; let passed = false; let failure: unknown;
let userId: string | undefined; let signatureFailures = 0; let unexpected = 0;
const interruption = new AbortController(); const interrupt = () => interruption.abort(new Error("Authenticated flow interrupted"));
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function processes() { interruption.signal.throwIfAborted(); if (children.some(child => child.exitCode !== null)) throw new Error("Owned authenticated-flow process exited"); }
async function queueEmpty() {
  const response = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: process.env.SQS_QUEUE_URL,
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"] }), { abortSignal: AbortSignal.timeout(8000) });
  return Object.keys(response.Attributes ?? {}).length === 3 && Object.values(response.Attributes!).every(value => value === "0");
}
async function call(path: string, method: string, headers: Record<string, string>, input?: unknown, status = 200) {
  processes();
  const response = await fetch(api + path, { method, headers: { "Content-Type": "application/json", ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.any([interruption.signal, AbortSignal.timeout(30000)]) });
  check(response.status === status, `${method} ${path} returned ${response.status}, expected ${status}`);
  const text = await response.text();
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}
function start(path: string) {
  const child = startProcess(path, { DATABASE_URL: primary.toString(), API_AUTH_MODE: "session", NODE_ENV: "development",
    API_PORT: String(port), AUTH_API_ORIGIN: api, AUTH_WEB_ORIGIN: origin, GITHUB_CLIENT_ID: "auth-flow-fixture", GITHUB_CLIENT_SECRET: "auth-flow-fixture",
    RECEIVER_URL: target, METRICS_ENABLED: "false", MAX_DELIVERY_ATTEMPTS: "3",
    INGESTION_RATE_LIMIT_CAPACITY: "10", INGESTION_RATE_LIMIT_REFILL_PER_SECOND: "10",
    DELIVERY_RATE_LIMIT_CAPACITY: "10", DELIVERY_RATE_LIMIT_REFILL_PER_SECOND: "10" }, `auth-flow-${runId}-${children.length}`);
  children.push(child); return child;
}
async function delivered(id: string) {
  processes();
  return receipts.has(id) && Boolean(await db.delivery.findFirst({ where: { eventId: id, status: "SUCCEEDED" } }));
}
try {
  await mkdir(resolve(root, "logs"), { recursive: true });
  await Bun.write(`${base}-manifest.json`, JSON.stringify({ runId, prefix, tenantIds: tenants.map(t => t.id), startedAt: Date.now(),
    config: { apiPort: port, authentication: "session plus ingestion-only bearer keys", session: "locally-created fixture, not a new GitHub authorization",
      acceptedHttpEvents: 2, seededDeadLetterEvents: 1, expectedReplays: 1, maxAttempts: 3, receiver: "signed local HTTP; original dead event always returns 500", sourcePayload: "existing development S3 object, reused read-only" },
    passCriteria: "Valid bearer and cookie ingestion succeed; malformed, cross-tenant, expired and revoked keys fail; keys cannot read/replay/manage credentials; CSRF is enforced; concurrent session replay creates one event; all owned work reaches expected durable outcomes and queue drains" }, null, 2));
  const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(null) }); await probe.stop(true);
  const listing = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "pipe" });
  const scanTimer = setTimeout(() => listing.kill("SIGKILL"), 5000);
  try {
    const [code, output, error] = await Promise.all([listing.exited, new Response(listing.stdout).text(), new Response(listing.stderr).text()]);
    check(code === 0, `Consumer check failed: ${error}`);
    check(!output.split("\n").some(line => /bun.*(?:run|watch).*packages\/worker\/src\/(?:index|outbox-poller)\.ts/.test(line)), "Stop other workers and publishers before this check");
  } finally { clearTimeout(scanTimer); }
  locked = (await lock.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(728401) AS locked`)[0]?.locked === true;
  check(locked && await queueEmpty() && await db.outbox.count({ where: { published: false } }) === 0, "Use an empty development queue/outbox with no competing publisher");
  await Bun.sleep(1000); check(await queueEmpty(), "Queue was not stably empty");
  const source = await db.event.findFirstOrThrow({ where: { tenantId: process.env.RECEIVER_TENANT_ID ?? "", payloadS3Key: { not: null } }, select: { payloadS3Key: true } });
  await readArchivedPayload(source.payloadS3Key!);
  await db.tenant.createMany({ data: tenants });
  await authRepository.createSession({ githubId, githubLogin: "auth-flow-fixture" }, { tokenHash: tokenHash(sessionToken), csrfToken: csrf, expiresAt: new Date(Date.now() + 600000) });
  userId = (await db.user.findUniqueOrThrow({ where: { githubId } })).id;
  await db.tenantMembership.create({ data: { userId, tenantId: tenant.id } });
  await redis.connect();
  receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    try {
      const bytes = new Uint8Array(await request.arrayBuffer()); const body = JSON.parse(new TextDecoder().decode(bytes)) as { eventId: string; tenantId: string; type: string };
      if (body.tenantId !== tenant.id || !body.type.startsWith(prefix)) { unexpected++; return new Response("unexpected", { status: 409 }); }
      if (!verifyWebhookSignature(bytes, request.headers.get(WEBHOOK_SIGNATURE_HEADER), tenant.hmacSecret)) { signatureFailures++; return new Response("invalid signature", { status: 401 }); }
      receipts.set(body.eventId, (receipts.get(body.eventId) ?? 0) + 1);
      return new Response(body.eventId === deadId ? "controlled failure" : "ok", { status: body.eventId === deadId ? 500 : 200 });
    } catch (error) { unexpected++; console.error("Authenticated-flow receiver failed", error); return new Response("invalid", { status: 400 }); }
  } });
  target = new URL("/webhook", receiver.url).toString();
  await Bun.write(`${base}-receiver.json`, JSON.stringify({ target, tenantIds: tenants.map(t => t.id) }, null, 2));
  start("packages/api/src/index.ts"); await waitFor(() => health(port), "authenticated API startup", 15000);
  const keyPath = `/tenants/${tenant.id}/api-keys`;
  await call(keyPath, "POST", { Cookie: cookie, Origin: origin }, { name: "missing csrf" }, 403);
  const key = await call(keyPath, "POST", sessionHeaders, { name: "auth-flow" }, 201);
  check(typeof key.token === "string" && typeof key.id === "string", "Key creation omitted credential or ID");
  const bearer = { Authorization: `Bearer ${key.token}` };
  const listed = await call(keyPath, "GET", { Cookie: cookie });
  check(!JSON.stringify(listed).includes(key.token) && !JSON.stringify(listed).includes("tokenHash"), "Key list disclosed a secret");
  await call("/events", "POST", { ...sessionHeaders, Authorization: "Bearer invalid" }, { tenantId: tenant.id, type: prefix + "denied", payload: {} }, 401);
  await call("/events", "POST", bearer, { tenantId: other.id, type: prefix + "denied", payload: {} }, 404);
  await call("/events", "POST", { Cookie: cookie, Origin: origin }, { tenantId: tenant.id, type: prefix + "denied", payload: {} }, 403);
  await call(`/tenants/${tenant.id}/deliveries`, "GET", bearer, undefined, 401);
  await call(keyPath, "GET", bearer, undefined, 401);
  await call(keyPath, "POST", bearer, { name: "denied" }, 401);
  const a = await call("/events", "POST", bearer, { tenantId: tenant.id, type: prefix + "bearer", payload: { runId } }, 201);
  const b = await call("/events", "POST", sessionHeaders, { tenantId: tenant.id, type: prefix + "cookie", payload: { runId } }, 201);
  check(typeof a.eventId === "string" && typeof b.eventId === "string", "Ingestion omitted event identities");
  check(await db.event.count({ where: { type: { startsWith: prefix } } }) === 2, "Rejected requests persisted work");
  checks.ingestion = { bearer: 201, session: 201, crossTenant: 404, invalidBearerWithValidCookie: 401, missingCsrf: 403 };
  await call(`${keyPath}/${key.id}/revoke`, "POST", sessionHeaders, {}, 200);
  await call("/events", "POST", bearer, { tenantId: tenant.id, type: prefix + "denied", payload: {} }, 401);
  const expired = await call(keyPath, "POST", sessionHeaders, { name: "expiry-fixture" }, 201);
  check(typeof expired.id === "string" && typeof expired.token === "string", "Expiry key missing");
  await db.apiKey.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
  await call("/events", "POST", { Authorization: `Bearer ${expired.token}` }, { tenantId: tenant.id, type: prefix + "denied", payload: {} }, 401);
  checks.keys = { showOnce: true, ingestionOnly: true, revokedRejected: true, expiredRejected: true };
  await db.event.create({ data: { id: deadId, tenantId: tenant.id, type: prefix + "dead", payloadS3Key: source.payloadS3Key, outbox: { create: {} } } });
  await lock.$queryRaw`SELECT pg_advisory_unlock(728401)`; locked = false; publicationStarted = true;
  start("packages/worker/src/outbox-poller.ts"); start("packages/worker/src/index.ts");
  await waitFor(async () => await delivered(a.eventId as string) && await delivered(b.eventId as string), "signed authenticated ingestion delivery", 90000);
  await waitFor(async () => { processes(); return Boolean(await db.deadLetter.findFirst({ where: { eventId: deadId } })); }, "exhausted fixture delivery", 120000);
  const dead = await db.deadLetter.findFirstOrThrow({ where: { eventId: deadId } });
  const replayPath = `/tenants/${tenant.id}/dead-letters/${dead.id}/replay`;
  await call(replayPath, "POST", bearer, {}, 401);
  await call(replayPath, "POST", { Cookie: cookie, Origin: origin }, {}, 403);
  const idempotencyKey = crypto.randomUUID();
  const replays = await Promise.all(Array.from({ length: 5 }, () => call(replayPath, "POST", { ...sessionHeaders, "Idempotency-Key": idempotencyKey }, {}, 202)));
  const replayId = replays[0]!.eventId;
  check(typeof replayId === "string" && replays.every(row => row.eventId === replayId), "Replay was not idempotent");
  check(await db.replay.count({ where: { sourceDeadLetterId: dead.id } }) === 1, "More than one replay command persisted");
  await waitFor(() => delivered(replayId), "authenticated replay signed delivery", 90000);
  const original = await db.delivery.findUniqueOrThrow({ where: { id: dead.deliveryId } });
  check(original.status === "DEAD_LETTERED" && original.attemptCount === 3 && receipts.get(deadId) === 3, "Replay altered original exhausted history");
  const second = await call(replayPath, "POST", { ...sessionHeaders, "Idempotency-Key": idempotencyKey }, {}, 202);
  check(second.eventId === replayId, "Replay identity changed after delivery");
  await waitFor(async () => { const result = await call(`/tenants/${tenant.id}/deliveries/summary`, "GET", { Cookie: cookie }); return result.total === 4; }, "authorized replica summary", 30000);
  let empty = 0;
  await waitFor(async () => { await Bun.sleep(1500); processes(); empty = await queueEmpty() && await db.outbox.count({ where: { published: false } }) === 0 ? empty + 1 : 0; return empty >= 2; }, "authenticated flow queue drain", 90000);
  const events = await db.event.findMany({ where: { type: { startsWith: prefix } }, select: { id: true, deliveries: { select: { status: true } } } });
  check(events.length === 4 && events.every(e => receipts.has(e.id) && e.deliveries.length === 1 && e.deliveries[0]!.status === (e.id === deadId ? "DEAD_LETTERED" : "SUCCEEDED")), "Owned outcomes incomplete");
  check(signatureFailures === 0 && unexpected === 0, "Receiver observed invalid traffic");
  checks.replay = { concurrentRequests: 5, replayEvents: 1, repeatedAfterDelivery: true, originalAttempts: 3, originalStatus: original.status };
  checks.outcomes = { events: 4, succeeded: 3, deadLettered: 1, signatureFailures, unexpected, repeatedCalls: [...receipts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0), queueDrained: true };
  const membershipKey = await call(keyPath, "POST", sessionHeaders, { name: "membership-fixture" }, 201);
  check(typeof membershipKey.token === "string", "Missing membership fixture key");
  await db.tenantMembership.delete({ where: { userId_tenantId: { userId, tenantId: tenant.id } } });
  await call("/events", "POST", { Authorization: `Bearer ${membershipKey.token}` }, { tenantId: tenant.id, type: prefix + "denied", payload: {} }, 401);
  await call(`/tenants/${tenant.id}/deliveries`, "GET", { Cookie: cookie }, undefined, 404);
  checks.membershipRevocation = true;
  await call("/auth/logout", "POST", sessionHeaders, undefined, 204);
  await call("/auth/me", "GET", { Cookie: cookie }, undefined, 401);
  checks.logout = { status: 204, subsequentIdentity: 401 };
  passed = true;
} catch (error) { failure = error; }
finally {
  const stopped = await Promise.allSettled(children.map(stopProcess));
  if (stopped.some(result => result.status === "rejected")) { passed = false; failure ??= new Error("Owned process cleanup failed"); }
  try {
    await db.user.deleteMany({ where: { githubId } });
    if (passed || !publicationStarted) {
      const events = await db.event.findMany({ where: { type: { startsWith: prefix } }, select: { id: true } }); const ids = events.map(e => e.id);
      await db.$transaction(async tx => {
        await tx.replay.deleteMany({ where: { eventId: { in: ids } } }); await tx.outbox.deleteMany({ where: { eventId: { in: ids } } });
        await tx.deadLetter.deleteMany({ where: { eventId: { in: ids } } }); await tx.delivery.deleteMany({ where: { eventId: { in: ids } } });
        await tx.event.deleteMany({ where: { id: { in: ids } } }); await tx.tenant.deleteMany({ where: { id: { in: tenants.map(t => t.id) } } });
      }, { timeout: 10000 });
      if (redis.status === "ready") await redis.del(...tenants.flatMap(t => [tenantRateLimitKey(t.id, "ingestion"), tenantRateLimitKey(t.id, "delivery")]), ...(target ? [circuitKeyForTarget(target)] : []));
    } else console.error(`Incomplete authenticated flow; owned work preserved: ${prefix}`);
  } catch (error) { passed = false; failure ??= error; }
  try { if (locked) await lock.$queryRaw`SELECT pg_advisory_unlock(728401)`; } catch (error) { passed = false; failure ??= error; }
  redis.disconnect();
  await receiver?.stop(true); await Promise.all([db.$disconnect(), lock.$disconnect(), disconnectAuth()]);
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  await Bun.write(`${base}-result.json`, JSON.stringify({ runId, prefix, passed, checks, failure: failure instanceof Error ? failure.message : failure ? String(failure) : null, finishedAt: Date.now(),
    caveats: "Real signed pipeline with a locally-created fixture session. Browser GitHub sign-in was verified separately. No user browser cookies or API-key secrets are saved in this report." }, null, 2));
}
if (!passed) throw failure ?? new Error("Authenticated flow did not pass");
console.log(JSON.stringify({ runId, passed, checks }));
