import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { GetQueueAttributesCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { prisma, createSingleConnectionPrisma, createSqsClient, verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER,
  consumeTenantToken, tenantRateLimitKey } from "../src/index";
import { createRedisClient, circuitKeyForTarget } from "../../worker/src/delivery/circuit-breaker";
import { readArchivedPayload } from "../../api/src/repositories/archived-payloads";
import { root, waitFor, startProcess, stopProcess, health, metric, monitoringCommand, type Child } from "./monitoring-checks";

const url = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "15432") throw new Error("Use the local Waybill database");
const runId = crypto.randomUUID();
const prefix = `phase8.${runId}.`;
const tenantId = crypto.randomUUID();
const secret = crypto.randomUUID();
const deadEventId = crypto.randomUUID();
const children: Child[] = [];
const received = new Map<string, number>();
const lock = createSingleConnectionPrisma();
const redis = createRedisClient();
const sqs = createSqsClient();
let receiver: ReturnType<typeof Bun.serve> | undefined;
let locked = false;
let publicationStarted = false;
let monitoringStopped = false;
let passed = false;
let signaturesRejected = 0;
let targetUrl = "";
let report: Record<string, unknown> = {};
const apiPort = 3108;

async function queueEmpty() {
  const response = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: process.env.SQS_QUEUE_URL,
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"] }),
    { abortSignal: AbortSignal.timeout(8000) });
  return response.Attributes !== undefined && Object.keys(response.Attributes).length === 3 && Object.values(response.Attributes).every(value => value === "0");
}
function start(path: string) {
  const child = startProcess(path, { API_AUTH_MODE: "development", API_PORT: String(apiPort), RECEIVER_URL: targetUrl, METRICS_ENABLED: "true",
    API_METRICS_PORT: "9100", PUBLISHER_METRICS_PORT: "9101", WORKER_METRICS_PORT: "9102", METRICS_HOST: "127.0.0.1",
    INGESTION_RATE_LIMIT_CAPACITY: "2", INGESTION_RATE_LIMIT_REFILL_PER_SECOND: "1",
    DELIVERY_RATE_LIMIT_CAPACITY: "1", DELIVERY_RATE_LIMIT_REFILL_PER_SECOND: "0.5", MAX_DELIVERY_ATTEMPTS: "3" }, `monitoring-flow-${runId}-${children.length}`);
  children.push(child);
  return child;
}
async function post(type: string) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/events`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, type: prefix + type, payload: { runId } }), signal: AbortSignal.timeout(10000) });
  const body = await response.json() as { eventId?: string };
  return { status: response.status, eventId: body.eventId };
}
async function succeeded(eventId: string) {
  return Boolean(received.has(eventId) && await prisma.delivery.findFirst({ where: { eventId, status: "SUCCEEDED" } }));
}

async function verifyPrometheusCounters() {
  const checks: [string, number][] = [
    ['sum(waybill_http_requests_total{job="waybill-api",verification!="true",operation="ingestion",status_class="4xx"})', await metric(9100, "waybill_http_requests_total", { operation: "ingestion", status_class: "4xx" })],
    ['sum(waybill_http_requests_total{job="waybill-api",verification!="true",operation="replay",status_class="2xx"})', await metric(9100, "waybill_http_requests_total", { operation: "replay", status_class: "2xx" })],
    ['sum(waybill_webhook_attempts_total{job="waybill-worker",verification!="true"})', await metric(9102, "waybill_webhook_attempts_total")],
    ['sum(waybill_delivery_retries_total{job="waybill-worker",verification!="true"})', await metric(9102, "waybill_delivery_retries_total")],
    ['sum(waybill_delivery_terminal_outcomes_total{job="waybill-worker",verification!="true"})', await metric(9102, "waybill_delivery_terminal_outcomes_total")],
    ['sum(waybill_outbox_publications_total{job="waybill-publisher",verification!="true",outcome="published"})', await metric(9101, "waybill_outbox_publications_total", { outcome: "published" })],
  ];
  await waitFor(async () => {
    for (const [expression, expected] of checks) {
      const response = await fetch(`http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(expression)}`, { signal: AbortSignal.timeout(5000) });
      const body = await response.json() as { status: string; data: { result: { value: [number, string] }[] } };
      if (!response.ok || body.status !== "success") throw new Error("Prometheus live-counter query failed");
      if (body.data.result.length !== 1 || Number(body.data.result[0].value[1]) !== expected) return false;
    }
    return true;
  }, "Prometheus stores all live scenario counters", 45000);
}

try {
  for (const port of [apiPort, 9100, 9101, 9102]) {
    const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(null) });
    await probe.stop(true);
  }
  await mkdir(resolve(root, "logs"), { recursive: true });
  const rows = await lock.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(728401) AS locked`;
  locked = rows[0]?.locked === true;
  if (!locked) throw new Error("Another publisher is running");
  if (!await queueEmpty() || await prisma.outbox.count({ where: { published: false } }) !== 0) throw new Error("Queue and outbox must be empty");
  const sourceTenant = await prisma.tenant.findUniqueOrThrow({ where: { id: process.env.RECEIVER_TENANT_ID ?? "" } });
  const source = await prisma.event.findFirstOrThrow({ where: { tenantId: sourceTenant.id, payloadS3Key: { not: null } } });
  await readArchivedPayload(source.payloadS3Key!);
  await redis.connect();
  const trusted = new Map([[tenantId, secret], [sourceTenant.id, sourceTenant.hmacSecret]]);
  receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { tenantId: string; eventId: string; type: string };
    const trustedSecret = trusted.get(body.tenantId);
    if (!trustedSecret || !verifyWebhookSignature(bytes, request.headers.get(WEBHOOK_SIGNATURE_HEADER), trustedSecret)) {
      signaturesRejected++;
      return new Response("invalid signature", { status: 401 });
    }
    if (!body.type.startsWith(prefix)) return new Response("unexpected event", { status: 409 });
    const attempt = (received.get(body.eventId) ?? 0) + 1;
    received.set(body.eventId, attempt);
    if (body.eventId === deadEventId || (body.type === prefix + "retry" && attempt === 1)) return new Response("controlled receiver failure", { status: 500 });
    return new Response("ok");
  } });
  targetUrl = new URL("/webhook", receiver.url).toString();
  await Bun.write(resolve(root, `logs/monitoring-flow-${runId}.json`), JSON.stringify({ runId, prefix, tenantId, deadEventId, targetUrl }));
  await prisma.tenant.create({ data: { id: tenantId, name: "phase8-monitoring-test", hmacSecret: secret } });
  start("packages/api/src/index.ts");
  await waitFor(() => health(apiPort), "API startup", 15000);
  const burst = await Promise.all(Array.from({ length: 10 }, () => post("success")));
  const accepted = burst.filter(result => result.status === 201 && result.eventId).map(result => result.eventId!);
  if (accepted.length !== 2 || burst.some(result => ![201, 429].includes(result.status))) throw new Error("Unexpected ingestion rate-limit results");
  await consumeTenantToken(redis, tenantId, "delivery", { capacity: 1, refillPerSecond: 0.5 });
  await lock.$queryRaw`SELECT pg_advisory_unlock(728401)`;
  locked = false;
  publicationStarted = true;
  start("packages/worker/src/outbox-poller.ts");
  start("packages/worker/src/index.ts");
  await waitFor(async () => (await Promise.all(accepted.map(succeeded))).every(Boolean), "successful signed deliveries");
  if (await metric(9102, "waybill_delivery_deferrals_total", { reason: "rate_limit" }) < 1) throw new Error("Expected a real delivery rate-limit deferral");
  console.log("PASS: accepted events delivered, ingestion rejections and delivery deferrals observed");
  const retry = await post("retry");
  if (retry.status !== 201 || !retry.eventId) throw new Error("Retry fixture not accepted");
  await waitFor(() => succeeded(retry.eventId!), "retry delivery");
  if (received.get(retry.eventId) !== 2) throw new Error("Retry did not perform exactly two webhook calls");
  console.log("PASS: receiver failure retried and delivered with verified signatures");

  await prisma.event.create({ data: { id: deadEventId, tenantId: sourceTenant.id, type: prefix + "dead", payloadS3Key: source.payloadS3Key, outbox: { create: {} } } });
  await waitFor(async () => Boolean(await prisma.deadLetter.findFirst({ where: { eventId: deadEventId } })), "dead-letter persistence");
  const failed = await prisma.delivery.findFirstOrThrow({ where: { eventId: deadEventId } });
  const dead = await prisma.deadLetter.findFirstOrThrow({ where: { eventId: deadEventId } });
  if (failed.status !== "DEAD_LETTERED" || failed.attemptCount !== 3 || received.get(deadEventId) !== 3) throw new Error("Accelerated three-attempt fixture did not dead-letter correctly");
  const key = crypto.randomUUID();
  const replayUrl = `http://127.0.0.1:${apiPort}/tenants/${sourceTenant.id}/dead-letters/${dead.id}/replay`;
  async function replay() {
    const response = await fetch(replayUrl, { method: "POST", headers: { "Idempotency-Key": key, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30000) });
    if (response.status !== 202) throw new Error(`Replay returned ${response.status}`);
    return await response.json() as { eventId: string };
  }
  const replays = await Promise.all([replay(), replay()]);
  if (replays[0].eventId !== replays[1].eventId) throw new Error("Replay was not idempotent");
  await waitFor(() => succeeded(replays[0].eventId), "replayed delivery");
  const original = await prisma.delivery.findUniqueOrThrow({ where: { id: failed.id } });
  if (original.status !== "DEAD_LETTERED" || original.attemptCount !== 3) throw new Error("Replay changed original history");
  console.log("PASS: archived failure replayed once through the outbox; original failure unchanged");
  await waitFor(queueEmpty, "queue drain before redelivery");
  const attempts = await metric(9102, "waybill_webhook_attempts_total");
  const terminal = await metric(9102, "waybill_delivery_terminal_outcomes_total");
  const deletes = await metric(9102, "waybill_sqs_operations_total", { operation: "delete", outcome: "success" });
  const event = await prisma.event.findUniqueOrThrow({ where: { id: accepted[0] } });
  await sqs.send(new SendMessageCommand({ QueueUrl: process.env.SQS_QUEUE_URL, MessageGroupId: event.tenantId,
    MessageBody: JSON.stringify({ eventId: event.id, tenantId: event.tenantId, type: event.type, payload: event.payload, payloadS3Key: event.payloadS3Key }),
    MessageAttributes: { tenantId: { DataType: "String", StringValue: event.tenantId } } }), { abortSignal: AbortSignal.timeout(8000) });
  await waitFor(async () => await metric(9102, "waybill_sqs_operations_total", { operation: "delete", outcome: "success" }) > deletes, "completed-message acknowledgement");
  if (await metric(9102, "waybill_webhook_attempts_total") !== attempts || await metric(9102, "waybill_delivery_terminal_outcomes_total") !== terminal) throw new Error("Completed redelivery inflated attempt or terminal counters");
  await waitFor(queueEmpty, "queue drain");
  await waitFor(async () => await metric(9101, "waybill_backlog_sample_success", { source: "sqs" }) === 1, "live AWS backlog sample");
  const prom = await fetch('http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D~%22waybill-(api%7Cpublisher%7Cworker)%22%7D', { signal: AbortSignal.timeout(5000) });
  const scraped = await prom.json() as { data: { result: { value: [number, string] }[] } };
  if (scraped.data.result.length !== 3 || scraped.data.result.some(row => row.value[1] !== "1")) throw new Error("Real process scrape target is down");
  await verifyPrometheusCounters();
  console.log("PASS: completed redelivery adds no attempt; live sampling and stored Prometheus scenario counters verified");

  monitoringStopped = true;
  await monitoringCommand("stop");
  const outage = await post("monitoring-outage");
  if (outage.status !== 201 || !outage.eventId) throw new Error("Ingestion failed during monitoring outage");
  await waitFor(() => succeeded(outage.eventId!), "delivery during monitoring outage");
  await waitFor(queueEmpty, "queue drain after outage");
  await monitoringCommand("up");
  monitoringStopped = false;
  await verifyPrometheusCounters();
  if (signaturesRejected !== 0) throw new Error("Receiver rejected a signature");
  report = { runId, accepted: accepted.length, rejected: burst.length - accepted.length, retryCalls: received.get(retry.eventId),
    deadLetterAttempts: original.attemptCount, replayCalls: received.get(replays[0].eventId), signaturesRejected,
    completedRedeliveryAddedAttempts: false, deliveryDuringMonitoringOutage: true, prometheusLiveCountersVerified: true,
    webhookAttempts: await metric(9102, "waybill_webhook_attempts_total"),
    terminalUpdates: await metric(9102, "waybill_delivery_terminal_outcomes_total"),
    retries: await metric(9102, "waybill_delivery_retries_total"),
    rateDeferrals: await metric(9102, "waybill_delivery_deferrals_total", { reason: "rate_limit" }) };
  passed = true;
  console.log("PASS: ingestion and delivery continue while Prometheus and Grafana are stopped");
} finally {
  try {
    if (monitoringStopped) await monitoringCommand("up");
  } finally {
    try {
      await Promise.all(children.map(stopProcess));
      if (passed || !publicationStarted) {
        const events = await prisma.event.findMany({ where: { type: { startsWith: prefix } }, select: { id: true } });
        const ids = events.map(event => event.id);
        await prisma.$transaction(async tx => {
          await tx.replay.deleteMany({ where: { eventId: { in: ids } } });
          await tx.outbox.deleteMany({ where: { eventId: { in: ids } } });
          await tx.deadLetter.deleteMany({ where: { eventId: { in: ids } } });
          await tx.delivery.deleteMany({ where: { eventId: { in: ids } } });
          await tx.event.deleteMany({ where: { id: { in: ids } } });
          await tx.tenant.deleteMany({ where: { id: tenantId } });
        });
        if (redis.status === "ready") await redis.del(tenantRateLimitKey(tenantId, "ingestion"), tenantRateLimitKey(tenantId, "delivery"), ...(targetUrl ? [circuitKeyForTarget(targetUrl)] : []));
      } else console.error("Live check incomplete: accepted test work is preserved under its run prefix and logs; no queued records were removed.");
    } finally {
      try {
        if (locked) await lock.$queryRaw`SELECT pg_advisory_unlock(728401)`;
      } finally {
        redis.disconnect();
        await Promise.all([receiver?.stop(true), prisma.$disconnect(), lock.$disconnect()]);
      }
    }
  }
}
await Bun.write(resolve(root, `logs/monitoring-flow-${runId}-result.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
console.log("Live monitoring flow passed. Owned records and processes removed; no S3 objects written or deleted.");
