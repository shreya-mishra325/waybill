import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { createSqsClient } from "../src/aws";
import { createSingleConnectionPrisma } from "../src/prisma";
import { createWebhookReceiver } from "./webhook-receiver";

const root = resolve(import.meta.dir, "../../..");
const primaryUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost"].includes(primaryUrl.hostname) || primaryUrl.port !== "15432") {
  throw new Error("Replay smoke test requires the local Waybill database");
}
const port = Number(process.env.REPLAY_TEST_API_PORT ?? 3107);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid replay test API port");
const db = createSingleConnectionPrisma();
const lock = createSingleConnectionPrisma();
const sqs = createSqsClient();
const runId = crypto.randomUUID();
const eventId = crypto.randomUUID();
const deliveryId = crypto.randomUUID();
const deadLetterId = crypto.randomUUID();
const key = crypto.randomUUID();
const children: ReturnType<typeof Bun.spawn>[] = [];
const received = new Set<string>();
let receiver: ReturnType<typeof Bun.serve> | undefined;
let replayEventId: string | undefined;
let locked = false;
let publicationStarted = false;
let passed = false;
let interrupted = false;
const stop = () => { interrupted = true; };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function queueEmpty() {
  const result = await sqs.send(new GetQueueAttributesCommand({QueueUrl: process.env.SQS_QUEUE_URL,
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"]}),
    {abortSignal: AbortSignal.timeout(8000)});
  return Object.values(result.Attributes ?? {}).length === 3 &&
    Object.values(result.Attributes ?? {}).every(value => Number(value) === 0);
}
async function waitFor(check: () => Promise<boolean>, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (!interrupted && Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error(interrupted ? "Replay test interrupted" : "Replay smoke test timed out");
}
function start(path: string, targetUrl: string) {
  const child = Bun.spawn([process.execPath, "run", path], {cwd: root,
    env: {...process.env, API_AUTH_MODE: "development", API_PORT: String(port), RECEIVER_URL: targetUrl},
    stdout: Bun.file(resolve(root, `logs/replay-${runId}-${children.length}.log`)),
    stderr: Bun.file(resolve(root, `logs/replay-${runId}-${children.length}.error.log`)),
  });
  children.push(child);
  return child;
}

try {
  let occupied = false;
  try {
    await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(1000)});
    occupied = true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  if (occupied) throw new Error("Replay smoke-test API port is already occupied");
  const rows = await lock.$queryRaw<{locked: boolean}[]>`SELECT pg_try_advisory_lock(728401) AS locked`;
  locked = rows[0]?.locked === true;
  if (!locked) throw new Error("Stop the outbox poller before the replay smoke test");
  if (!await queueEmpty() || await db.outbox.count({where: {published: false}}) !== 0) {
    throw new Error("Drain the development queue and outbox before the replay smoke test");
  }
  const tenant = await db.tenant.findUniqueOrThrow({where: {id: process.env.RECEIVER_TENANT_ID ?? ""}});
  const source = await db.event.findFirstOrThrow({where: {tenantId: tenant.id, payloadS3Key: {not: null}}});
  const handler = createWebhookReceiver(tenant.id, tenant.hmacSecret);
  receiver = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(req) {
    const copy = req.clone();
    const response = await handler(req);
    if (response.status === 200) {
      const body = await copy.json() as {eventId?: unknown};
      if (typeof body.eventId === "string") received.add(body.eventId);
    }
    return response;
  }});
  const targetUrl = new URL("/webhook", receiver.url).toString();
  await mkdir(resolve(root, "logs"), {recursive: true});
  await db.$transaction(async tx => {
    await tx.event.create({data: {id: eventId, tenantId: tenant.id, type: "phase7.replay.test", payloadS3Key: source.payloadS3Key}});
    await tx.delivery.create({data: {id: deliveryId, eventId, tenantId: tenant.id, targetUrl,
      status: "DEAD_LETTERED", attemptCount: 8, lastError: "replay smoke fixture"}});
    await tx.deadLetter.create({data: {id: deadLetterId, eventId, deliveryId, tenantId: tenant.id,
      targetUrl, attemptCount: 8, payloadS3Key: source.payloadS3Key!}});
  });
  const api = start("packages/api/src/index.ts", targetUrl);
  await waitFor(async () => {
    if (api.exitCode !== null) throw new Error("Smoke-test API exited unexpectedly");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(1000)});
      await response.text();
      return response.ok;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return false;
    }
  }, 15000);
  const endpoint = `http://127.0.0.1:${port}/tenants/${tenant.id}/dead-letters/${deadLetterId}/replay`;
  async function replay(requestKey: string | undefined, destination = endpoint) {
    const response = await fetch(destination, {method: "POST", headers: {
      "Content-Type": "application/json", ...(requestKey ? {"Idempotency-Key": requestKey} : {}),
    }, body: "{}", signal: AbortSignal.timeout(30000)});
    const body = await response.json() as {eventId?: string; replayId?: string; error?: string};
    return {status: response.status, body};
  }
  if ((await replay(undefined)).status !== 400) throw new Error("Missing idempotency key was not rejected");
  if ((await replay(key, endpoint.replace(tenant.id, crypto.randomUUID()))).status !== 404) {
    throw new Error("Another tenant could access the replay source");
  }
  const requests = await Promise.all([replay(key), replay(key)]);
  if (requests.some(result => result.status !== 202) || !requests[0]?.body.eventId ||
      requests[0].body.eventId !== requests[1]?.body.eventId) throw new Error("Replay requests were not idempotent");
  replayEventId = requests[0].body.eventId;
  if (replayEventId === eventId) throw new Error("Replay reused the original delivery identity");
  if ((await replay(crypto.randomUUID())).status !== 409) throw new Error("Second independent replay was not rejected");
  const pending = await db.outbox.findUniqueOrThrow({where: {eventId: replayEventId}});
  if (pending.published) throw new Error("Expected a durable unpublished replay before publisher startup");
  console.log("Concurrent POSTs returned one replay; its outbox row persisted before publication");
  api.kill("SIGTERM");
  const stopTimer = setTimeout(() => api.kill("SIGKILL"), 5000);
  try { await api.exited; } finally { clearTimeout(stopTimer); }
  console.log("Smoke-test API stopped after commit and before publisher startup");
  await Bun.write(resolve(root, `logs/replay-test-${runId}.json`), JSON.stringify({eventId, deliveryId,
    deadLetterId, replayEventId, targetUrl, idempotencyKey: key}, null, 2));
  await lock.$queryRaw`SELECT pg_advisory_unlock(728401)`;
  locked = false;
  publicationStarted = true;
  start("packages/worker/src/outbox-poller.ts", targetUrl);
  start("packages/worker/src/index.ts", targetUrl);
  await waitFor(async () => {
    const delivery = await db.delivery.findFirst({where: {eventId: replayEventId, status: "SUCCEEDED"}});
    return Boolean(delivery && received.has(replayEventId!));
  });
  await waitFor(queueEmpty, 30000);
  const original = await db.delivery.findUniqueOrThrow({where: {id: deliveryId}});
  const delivered = await db.delivery.findFirstOrThrow({where: {eventId: replayEventId}});
  if (original.status !== "DEAD_LETTERED" || original.attemptCount !== 8 || delivered.attemptCount !== 1) {
    throw new Error("Replay changed original history or failed to start a fresh retry budget");
  }
  const restartedApi = start("packages/api/src/index.ts", targetUrl);
  await waitFor(async () => {
    if (restartedApi.exitCode !== null) throw new Error("Restarted smoke-test API exited unexpectedly");
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(1000)});
      await health.text();
      return health.ok;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return false;
    }
  }, 15000);
  if ((await replay(key)).body.eventId !== replayEventId) throw new Error("Idempotency changed after delivery");
  passed = true;
  console.log(JSON.stringify({replayStatus: delivered.status, replayAttempts: delivered.attemptCount,
    originalStatus: original.status, originalAttempts: original.attemptCount, signatureVerified: true}));
} finally {
  try {
    for (const child of children) child.kill("SIGTERM");
    for (const child of children) {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await child.exited; } finally { clearTimeout(timer); }
    }
    if (passed || !publicationStarted) {
      await db.$transaction(async tx => {
        const stored = await tx.replay.findMany({where: {sourceDeadLetterId: deadLetterId}, select: {eventId: true}});
        const ids = [...new Set([eventId, ...stored.map(row => row.eventId), ...(replayEventId ? [replayEventId] : [])])];
        await tx.replay.deleteMany({where: {sourceDeadLetterId: deadLetterId}});
        await tx.outbox.deleteMany({where: {eventId: {in: ids}}});
        await tx.deadLetter.deleteMany({where: {eventId: {in: ids}}});
        await tx.delivery.deleteMany({where: {eventId: {in: ids}}});
        await tx.event.deleteMany({where: {id: {in: ids}}});
      });
    } else {
      console.error("Replay test did not complete; accepted work is preserved. Inspect the replay-test log before draining it.");
    }
  } finally {
    if (locked) await lock.$queryRaw`SELECT pg_advisory_unlock(728401)`;
    receiver?.stop(true);
    await Promise.all([db.$disconnect(), lock.$disconnect()]);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
console.log("Replay smoke test passed; owned services stopped and test records removed. No S3 objects were written.");
