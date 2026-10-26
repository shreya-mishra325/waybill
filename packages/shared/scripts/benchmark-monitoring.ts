import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, platform, arch } from "node:os";
import { prisma, createSingleConnectionPrisma, createWorkerMetrics, startMetricsServer, tenantRateLimitKey } from "../src/index";
import { createRedisClient } from "../../worker/src/delivery/circuit-breaker";
import { postWebhook } from "../../worker/src/delivery/http";
import { createWebhookReceiver } from "./webhook-receiver";
import { root, startProcess, stopProcess, health, waitFor } from "./monitoring-checks";

const url = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== "15432") throw new Error("Use the local Waybill database");
const runId = crypto.randomUUID();
const tenantId = crypto.randomUUID();
const secret = crypto.randomUUID();
const samples = 250;
const warmup = 25;
const order = [false, true, true, false, false, true, true, false];
const lock = createSingleConnectionPrisma();
const redis = createRedisClient();
let locked = false;
let receiver: ReturnType<typeof Bun.serve> | undefined;
let active: ReturnType<typeof startProcess> | undefined;
const apiRows: Record<string, number | boolean>[] = [];
const webhookRows: Record<string, number | boolean>[] = [];
function quantile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}
async function scrape(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(5000) });
  await response.text();
  if (!response.ok) throw new Error("Benchmark scrape failed");
}
try {
  await mkdir(resolve(root, "logs"), { recursive: true });
  const rows = await lock.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(728401) AS locked`;
  locked = rows[0]?.locked === true;
  if (!locked || await prisma.outbox.count({ where: { published: false } }) !== 0) throw new Error("Stop publishers and use an empty development outbox");
  for (const port of [3109, 19100, 19102]) {
    const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(null) });
    await probe.stop(true);
  }
  await redis.connect();
  await prisma.tenant.create({ data: { id: tenantId, name: "phase8-overhead-probe", hmacSecret: secret } });
  receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createWebhookReceiver(tenantId, secret) });
  const target = new URL("/webhook", receiver.url).toString();
  console.log("Probe declared: eight OFF/ON/ON/OFF/OFF/ON/ON/OFF trials, 25 warmups and 250 measured calls each.");
  console.log("API concurrency 4; webhook concurrency 1; metrics-on trials include two explicit scrapes. No SQS or S3 calls.");

  for (const [trial, enabled] of order.entries()) {
    active = startProcess("packages/api/src/index.ts", { API_PORT: "3109", METRICS_ENABLED: String(enabled), API_METRICS_PORT: "19100", METRICS_HOST: "127.0.0.1",
      INGESTION_RATE_LIMIT_CAPACITY: "100000", INGESTION_RATE_LIMIT_REFILL_PER_SECOND: "100000" }, `overhead-${runId}-api-${trial}`);
    const child = active;
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error("Benchmark API exited");
      return health(3109);
    }, "benchmark API startup", 15000);
    async function ingest() {
      const response = await fetch("http://127.0.0.1:3109/events", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, type: "phase8.overhead", payload: { value: 1 } }), signal: AbortSignal.timeout(10000) });
      await response.text();
      if (response.status !== 201) throw new Error(`Benchmark ingestion returned ${response.status}`);
    }
    for (let index = 0; index < warmup; index++) await ingest();
    const latencies: number[] = [];
    let next = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (true) {
        const index = next++;
        if (index >= samples) return;
        if (enabled && (index === 83 || index === 166)) await scrape(19100);
        const at = performance.now();
        await ingest();
        latencies.push(performance.now() - at);
      }
    }));
    const elapsedMs = performance.now() - started;
    await stopProcess(child);
    active = undefined;
    const usage = child.resourceUsage();
    apiRows.push({ trial, enabled, elapsedMs, requestsPerSecond: samples * 1000 / elapsedMs, p95Ms: quantile(latencies, 0.95),
      lifetimeCpuMs: Number(usage?.cpuTime.total ?? 0) / 1000, lifetimeMaxRssBytes: Number(usage?.maxRSS ?? 0) });
    console.log(`API trial ${trial + 1}/8 ${enabled ? "ON" : "OFF"}: ${(samples * 1000 / elapsedMs).toFixed(1)} req/s, p95 ${quantile(latencies, 0.95).toFixed(2)} ms`);
  }
  for (const [trial, enabled] of order.entries()) {
    const metrics = enabled ? createWorkerMetrics(() => 0) : undefined;
    const server = metrics ? startMetricsServer(metrics.registry, { hostname: "127.0.0.1", port: 19102 }) : undefined;
    async function deliver() {
      const at = performance.now();
      const result = await postWebhook(target, { tenantId, eventId: "overhead-probe", type: "phase8.overhead", payload: { value: 1 } }, secret);
      metrics?.recordWebhook(result.ok ? "success" : "failure", (performance.now() - at) / 1000);
      if (!result.ok) throw new Error("Benchmark webhook failed");
    }
    try {
      for (let index = 0; index < warmup; index++) await deliver();
      const latencies: number[] = [];
      const cpu = process.cpuUsage();
      const started = performance.now();
      for (let index = 0; index < samples; index++) {
        if (enabled && (index === 83 || index === 166)) await scrape(19102);
        const at = performance.now();
        await deliver();
        latencies.push(performance.now() - at);
      }
      const elapsedMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      webhookRows.push({ trial, enabled, elapsedMs, requestsPerSecond: samples * 1000 / elapsedMs, p95Ms: quantile(latencies, 0.95), cpuMs: (used.user + used.system) / 1000 });
      console.log(`Webhook trial ${trial + 1}/8 ${enabled ? "ON" : "OFF"}: ${(samples * 1000 / elapsedMs).toFixed(1)} req/s, p95 ${quantile(latencies, 0.95).toFixed(2)} ms`);
    } finally { await server?.stop(true); }
  }
  function summary(rows: typeof apiRows) {
    function median(key: string, enabled: boolean) {
      const values = rows.filter(row => row.enabled === enabled).map(row => Number(row[key])).sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    }
    const offRps = median("requestsPerSecond", false);
    const onRps = median("requestsPerSecond", true);
    const offP95 = median("p95Ms", false);
    const onP95 = median("p95Ms", true);
    return { offRps, onRps, throughputDropPct: 100 * (offRps - onRps) / offRps, offP95Ms: offP95, onP95Ms: onP95, p95IncreasePct: 100 * (onP95 - offP95) / offP95 };
  }
  const report = { runId, bun: Bun.version, platform: platform(), arch: arch(), logicalCpus: cpus().length,
    samples, warmup, order, apiConcurrency: 4, webhookConcurrency: 1, explicitScrapesPerEnabledTrial: 2,
    api: summary(apiRows), webhook: summary(webhookRows), apiTrials: apiRows, webhookTrials: webhookRows,
    limitations: "Small local component probe. API includes real Redis and PostgreSQL ingestion but no publication. Webhook probe covers signing, local HTTP verification and attempt metrics only. Does not measure full worker, sampling, SQS throughput, or end-to-end latency. API CPU includes startup and warmup. Timing is descriptive, not a capacity or latency guarantee." };
  await Bun.write(resolve(root, `logs/monitoring-overhead-${runId}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ api: report.api, webhook: report.webhook, report: `logs/monitoring-overhead-${runId}.json` }));
} finally {
  try {
    if (active) await stopProcess(active);
    await receiver?.stop(true);
    await prisma.$transaction(async tx => {
      await tx.outbox.deleteMany({ where: { event: { tenantId } } });
      await tx.event.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
    if (redis.status === "ready") await redis.del(tenantRateLimitKey(tenantId, "ingestion"));
  } finally {
    try {
      if (locked) await lock.$queryRaw`SELECT pg_advisory_unlock(728401)`;
    } finally {
      redis.disconnect();
      await Promise.all([prisma.$disconnect(), lock.$disconnect()]);
    }
  }
}
console.log("Probe fixtures removed. The publisher lock was held throughout; no events were sent to AWS.");
