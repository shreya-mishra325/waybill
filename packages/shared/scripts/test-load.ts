import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { arch, cpus, platform } from "node:os";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { createSingleConnectionPrisma, createSqsClient, verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER, tenantRateLimitKey } from "../src/index";
import { createRedisClient, circuitKeyForTarget } from "../../worker/src/delivery/circuit-breaker";
import { root, startProcess, stopProcess, health, waitFor, type Child } from "./monitoring-checks";
import { loadReport, loadTenantIndex, type LoadRequest, type LoadReceipt, type LoadOutcome, type LoadLimits } from "./load-report";

function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

async function command(args: string[], timeout = 10000) {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  try {
    const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`${args[0]} failed: ${error.trim()}`);
    return output;
  } finally { clearTimeout(timer); }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`Runs the real API, publisher, worker, and signed receiver against the development SQS queue.
Requires local PostgreSQL on 15432, Redis, running Prometheus/Grafana, empty queue/outbox, and no other consumers.
Defaults: 60 seconds, 5 requests/second, concurrency cap 20, 3 evenly mixed tenants, 1024-byte payload data, healthy receiver.
Each request has a fixed scheduled time; overload is recorded rather than hidden by reducing the offered rate.
Options: LOAD_DURATION_SECONDS (10..600), LOAD_RATE (1..100), LOAD_CONCURRENCY (1..100), LOAD_TENANTS (1..20),
LOAD_PAYLOAD_BYTES (1..131072), LOAD_RECEIVER_DELAY_MS (0..1000), LOAD_DRAIN_SECONDS (30..1800),
LOAD_P95_MS, LOAD_MAX_MS, LOAD_SCHEDULE_LAG_MS.
--pressure defaults: 120 seconds, 6 tenants, busy tenant 10/second, each quiet tenant 1/second, busy receiver delay 100ms.
Pressure options: LOAD_BUSY_RATE, LOAD_BUSY_RECEIVER_DELAY_MS, LOAD_BUSY_P95_MS, LOAD_BUSY_MAX_MS, LOAD_MIN_BUSY_PENDING.
Quiet limits stay 30-second p95 / 90-second maximum; busy limits are 600 / 900 seconds. See docs/PHASE_9_NOTES.md.
No queue purge or S3 fixture uploads. Failed runs preserve accepted work. Reports and process logs go under logs/.`);
    return;
  }
  if (process.argv.slice(2).some(argument => argument !== "--pressure")) throw new Error("Only --help and --pressure are supported");
  const pressure = process.argv.includes("--pressure");
  const busyRate = pressure ? integer("LOAD_BUSY_RATE", 10, 1, 50) : undefined;
  const tenantCount = integer("LOAD_TENANTS", pressure ? 6 : 3, pressure ? 2 : 1, 20);
  const database = new URL(process.env.DATABASE_URL ?? "");
  if (!["localhost", "127.0.0.1"].includes(database.hostname) || database.port !== "15432") throw new Error("Use the local Waybill database on 15432");
  if (new URL(process.env.SQS_QUEUE_URL ?? "").pathname.endsWith(".fifo")) throw new Error("The baseline requires the existing standard queue");
  database.searchParams.set("socket_timeout", "10");
  const config = {
    profile: pressure ? "pressure" : "balanced",
    durationSeconds: integer("LOAD_DURATION_SECONDS", pressure ? 120 : 60, 10, 600), rate: integer("LOAD_RATE", busyRate === undefined ? 5 : busyRate + tenantCount - 1, 1, 100),
    concurrency: integer("LOAD_CONCURRENCY", 20, 1, 100), tenantCount, busyRate,
    busyReceiverDelayMs: integer("LOAD_BUSY_RECEIVER_DELAY_MS", pressure ? 100 : 0, 0, 1000),
    busyP95Ms: integer("LOAD_BUSY_P95_MS", 600000, 1, 1800000), busyMaxMs: integer("LOAD_BUSY_MAX_MS", 900000, 1, 1800000),
    minBusyPending: integer("LOAD_MIN_BUSY_PENDING", 100, 1, 100000),
    payloadBytes: integer("LOAD_PAYLOAD_BYTES", 1024, 1, 131072), receiverDelayMs: integer("LOAD_RECEIVER_DELAY_MS", 0, 0, 1000),
    drainSeconds: integer("LOAD_DRAIN_SECONDS", pressure ? 900 : 180, 30, 1800), p95Ms: integer("LOAD_P95_MS", 30000, 1, 1800000),
    maxMs: integer("LOAD_MAX_MS", 90000, 1, 1800000), maxScheduleLagMs: integer("LOAD_SCHEDULE_LAG_MS", 250, 1, 10000),
    requireAllAccepted: true, sampleIntervalMs: 10000, apiPort: 3110,
    ingestionBudget: { capacity: 20, refillPerSecond: 10 }, deliveryBudget: { capacity: 10, refillPerSecond: 10 },
  };
  if (busyRate !== undefined && config.rate !== busyRate + tenantCount - 1) throw new Error("Pressure LOAD_RATE must equal LOAD_BUSY_RATE plus one request per quiet tenant");
  const runId = crypto.randomUUID();
  const prefix = `phase9.${runId}.`;
  const tenants = Array.from({ length: config.tenantCount }, (_, index) => ({ id: crypto.randomUUID(), name: `phase9-load-${index}`, hmacSecret: crypto.randomUUID() }));
  const secrets = new Map<string, string>(tenants.map(tenant => [tenant.id, tenant.hmacSecret]));
  const planned = config.rate * config.durationSeconds;
  const limits: LoadLimits = { ...config, planned, fairness: pressure ? {
    busyTenantId: tenants[0]!.id, quietTenantIds: tenants.slice(1).map(tenant => tenant.id), busyRequests: busyRate! * config.durationSeconds,
    quietRequestsPerTenant: config.durationSeconds, busyP95Ms: config.busyP95Ms, busyMaxMs: config.busyMaxMs,
    minBusyPending: config.minBusyPending, minOverlappingRequests: 3,
  } : undefined };
  const tenantForSequence = (sequence: number) => tenants[loadTenantIndex(sequence, tenants.length, busyRate)]!;
  const busyPending = () => pressure ? requests.filter(request => request.tenantId === tenants[0]!.id && request.status === 201 && request.eventId && !receipts.has(request.eventId)).length : 0;
  const base = resolve(root, `logs/load-${runId}`);
  const requests: LoadRequest[] = [];
  const receipts = new Map<string, LoadReceipt>();
  const children: { role: string; child: Child }[] = [];
  const telemetry: Record<string, unknown>[] = [];
  const telemetryErrors: string[] = [];
  const db = createSingleConnectionPrisma();
  const lock = createSingleConnectionPrisma();
  const redis = createRedisClient();
  const sqs = createSqsClient();
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error("Load run interrupted"));
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  let locked = false;
  let publicationStarted = false;
  let fixturesCreated = false;
  let receiver: ReturnType<typeof Bun.serve> | undefined;
  let target = "";
  let signaturesRejected = 0;
  let unexpected = 0;
  let stopSampling = false;
  let sampling: Promise<void> | undefined;
  let failure: unknown;
  let outcome: ReturnType<typeof loadReport> | undefined;
  let outcomes: LoadOutcome[] = [];
  let startedAt = 0;
  let submissionsFinishedAt = 0;
  let durableCompleteAt = 0;
  let drainedAt = 0;
  let queueChecks = 0;
  const resources: Record<string, unknown>[] = [];

  function assertProcesses() {
    abort.signal.throwIfAborted();
    for (const entry of children) if (entry.child.exitCode !== null) throw new Error(`${entry.role} exited during load; inspect its run log`);
  }
  async function queueEmpty() {
    queueChecks++;
    const result = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: process.env.SQS_QUEUE_URL,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"] }),
      { abortSignal: AbortSignal.timeout(8000) });
    return (["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"] as const)
      .every(name => result.Attributes?.[name] === "0");
  }
  async function query(expression: string) {
    const response = await fetch(`http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(expression)}`, { signal: AbortSignal.timeout(5000) });
    const body = await response.json() as { status: string; data?: { result: { metric: Record<string, string>; value: [number, string] }[] } };
    if (!response.ok || body.status !== "success" || !body.data) throw new Error("Prometheus query failed");
    return body.data.result;
  }
  async function sample() {
    const at = Date.now();
    const snapshots = await Promise.all(children.map(async ({ role }, index) => {
      const response = await fetch(`http://127.0.0.1:${9100 + index}/metrics`, { signal: AbortSignal.timeout(5000) });
      const text = await response.text();
      if (!response.ok) throw new Error(`${role} scrape failed`);
      await Bun.write(`${base}-${at}-${role}.prom`, text);
      return { role, residentMemoryBytes: Number(text.match(/^waybill_process_resident_memory_bytes(?:\{[^}]*\})? (\d+)/m)?.[1]),
        backlogSampleSuccess: role === "publisher" ? [...text.matchAll(/^waybill_backlog_sample_success\{[^}]*source="(outbox|sqs)"[^}]*\} (\d+)/gm)].map(match => ({ source: match[1], success: Number(match[2]) })) : undefined };
    }));
    const containers = (await command(["docker", "ps", "--filter", "name=waybill", "--format", "{{.Names}}"])).trim().split("\n").filter(Boolean);
    if (!containers.some(name => name.includes("prometheus")) || !containers.some(name => name.includes("grafana"))) throw new Error("Monitoring containers must remain running");
    const docker = (await command(["docker", "stats", "--no-stream", "--format", "{{json .}}", ...containers])).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as unknown);
    const hostProcesses = await command(["ps", "-p", [process.pid, ...children.map(entry => entry.child.pid)].join(","), "-o", "pid=,%cpu=,rss=,etime="]);
    telemetry.push({ at, scrapeCompletedAt: Date.now(), processes: snapshots, hostProcesses, docker });
    await Bun.write(`${base}-telemetry.json`, JSON.stringify(telemetry, null, 2));
    console.log(`Progress: ${requests.filter(request => request.status === 201).length} accepted, ${receipts.size} received, ${busyPending()} accepted busy events awaiting receipt.`);
  }
  async function submit(sequence: number, scheduledAt: number) {
    const tenant = tenantForSequence(sequence);
    const entry: LoadRequest = { sequence, tenantId: tenant.id, scheduledAt, sentAt: Date.now(), busyPendingAtSubmission: pressure ? busyPending() : undefined };
    requests.push(entry);
    try {
      const response = await fetch(`http://127.0.0.1:${config.apiPort}/events`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: tenant.id, type: prefix + "steady", payload: { runId, sequence, data: "x".repeat(config.payloadBytes) } }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
      entry.status = response.status;
      const body = await response.json() as { eventId?: unknown; storedIn?: unknown };
      if (response.status === 201) {
        if (typeof body.eventId !== "string" || body.storedIn !== "postgres") throw new Error("Unexpected accepted event response");
        entry.eventId = body.eventId;
      }
    } catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
    finally { entry.finishedAt = Date.now(); }
  }

  try {
    await mkdir(resolve(root, "logs"), { recursive: true });
    await Bun.write(`${base}-manifest.json`, JSON.stringify({ runId, prefix, config, limits, planned, tenantIds: tenants.map(tenant => tenant.id),
      tool: "Bun fixed-arrival HTTP generator", declaredAt: new Date().toISOString(), machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cpuCount: cpus().length },
      passCriteria: "Every scheduled request accepted, every accepted event signed and durably succeeded, each tenant within p95/max limits, schedule lag within limit, queue/outbox drained, Prometheus counters and background samples verified, resource samples available" }, null, 2));
    console.log(`Declared load: ${planned} requests, ${config.rate}/second for ${config.durationSeconds}s, ${config.tenantCount} tenants, ${config.payloadBytes}-byte payload data, quiet receiver delay ${config.receiverDelayMs}ms, busy receiver delay ${config.busyReceiverDelayMs}ms, busy rate ${busyRate ?? "balanced"}.`);
    for (const port of [config.apiPort, 9100, 9101, 9102]) {
      const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(null) });
      await probe.stop(true);
    }
    const active = await command(["ps", "-axo", "pid=,command="]);
    if (active.split("\n").some(line => /bun.*(?:run|watch).*packages\/worker\/src\/(?:index|outbox-poller)\.ts/.test(line))) throw new Error("Stop other delivery workers and publishers before the load run");
    const rows = await lock.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(728401) AS locked`;
    locked = rows[0]?.locked === true;
    if (!locked) throw new Error("Another publisher holds the leader lock");
    if (!await queueEmpty() || await db.outbox.count({ where: { published: false } }) !== 0) throw new Error("Queue and outbox must be empty before load testing");
    await Bun.sleep(1000);
    if (!await queueEmpty()) throw new Error("Queue was not stably empty");
    const ready = await fetch("http://127.0.0.1:9090/-/ready", { signal: AbortSignal.timeout(3000) });
    await ready.text();
    if (!ready.ok) throw new Error("Start monitoring before load testing");
    const grafana = await fetch("http://127.0.0.1:3300/api/health", { signal: AbortSignal.timeout(3000) });
    await grafana.text();
    if (!grafana.ok) throw new Error("Grafana is unavailable");
    await redis.connect();
    await db.tenant.createMany({ data: tenants });
    fixturesCreated = true;
    receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      try {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const body = JSON.parse(new TextDecoder().decode(bytes)) as { tenantId: string; eventId: string; type: string; payload?: { runId?: string; sequence?: number; data?: string } };
        const secret = secrets.get(body.tenantId);
        if (!secret || !verifyWebhookSignature(bytes, request.headers.get(WEBHOOK_SIGNATURE_HEADER), secret)) {
          signaturesRejected++;
          return new Response("invalid signature", { status: 401 });
        }
        const sequence = body.payload?.sequence;
        if (body.type !== prefix + "steady" || body.payload?.runId !== runId || !Number.isSafeInteger(sequence) || sequence! < 0 || sequence! >= planned ||
            tenantForSequence(sequence!).id !== body.tenantId || body.payload?.data !== "x".repeat(config.payloadBytes)) {
          unexpected++;
          return new Response("unexpected event", { status: 409 });
        }
        const delay = pressure && body.tenantId === tenants[0]!.id ? config.busyReceiverDelayMs : config.receiverDelayMs;
        if (delay) await Bun.sleep(delay);
        const prior = receipts.get(body.eventId);
        receipts.set(body.eventId, { tenantId: body.tenantId, at: prior?.at ?? Date.now(), calls: (prior?.calls ?? 0) + 1 });
        return new Response("ok");
      } catch (error) {
        unexpected++;
        console.error("Load receiver failed", error);
        return new Response("invalid envelope", { status: 400 });
      }
    } });
    target = new URL("/webhook", receiver.url).toString();
    const env = { API_PORT: String(config.apiPort), DATABASE_URL: database.toString(), RECEIVER_URL: target, METRICS_ENABLED: "true", METRICS_HOST: "127.0.0.1",
      API_METRICS_PORT: "9100", PUBLISHER_METRICS_PORT: "9101", WORKER_METRICS_PORT: "9102",
      INGESTION_RATE_LIMIT_CAPACITY: "20", INGESTION_RATE_LIMIT_REFILL_PER_SECOND: "10", DELIVERY_RATE_LIMIT_CAPACITY: "10", DELIVERY_RATE_LIMIT_REFILL_PER_SECOND: "10",
      SQS_MAX_MESSAGE_BYTES: "262144" };
    children.push({ role: "api", child: startProcess("packages/api/src/index.ts", env, `load-${runId}-api`) });
    await waitFor(async () => { assertProcesses(); return health(config.apiPort); }, "load API startup", 15000);
    await lock.$queryRaw`SELECT pg_advisory_unlock(728401)`;
    locked = false;
    publicationStarted = true;
    children.push({ role: "publisher", child: startProcess("packages/worker/src/outbox-poller.ts", env, `load-${runId}-publisher`) });
    children.push({ role: "worker", child: startProcess("packages/worker/src/index.ts", env, `load-${runId}-worker`) });
    await waitFor(async () => {
      assertProcesses();
      const targets = await query('up{job=~"waybill-(api|publisher|worker)",verification!="true"}');
      return targets.length === 3 && targets.every(row => row.value[1] === "1");
    }, "Prometheus scrapes all three owned processes", 45000);
    await sample();
    sampling = (async () => {
      while (!stopSampling) {
        for (let elapsed = 0; elapsed < config.sampleIntervalMs && !stopSampling; elapsed += 100) await Bun.sleep(100);
        if (stopSampling) break;
        try { assertProcesses(); await sample(); }
        catch (error) { telemetryErrors.push(error instanceof Error ? error.message : String(error)); }
      }
    })();
    startedAt = Date.now();
    const start = performance.now();
    const pending = new Set<Promise<void>>();
    for (let sequence = 0; sequence < planned; sequence++) {
      assertProcesses();
      const due = start + sequence * 1000 / config.rate;
      await Bun.sleep(Math.max(0, due - performance.now()));
      if (pending.size >= config.concurrency) {
        requests.push({ sequence, tenantId: tenantForSequence(sequence).id, scheduledAt: startedAt + sequence * 1000 / config.rate, error: "Generator concurrency cap reached" });
        continue;
      }
      const task = submit(sequence, startedAt + sequence * 1000 / config.rate);
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
    await Promise.all(pending);
    await Bun.sleep(Math.max(0, start + config.durationSeconds * 1000 - performance.now()));
    submissionsFinishedAt = Date.now();
    await Bun.write(`${base}-requests.json`, JSON.stringify(requests, null, 2));
    console.log(`Submissions finished: ${requests.filter(request => request.status === 201).length} accepted. Waiting for durable outcomes and queue drain.`);
    await waitFor(async () => {
      assertProcesses();
      outcomes = await db.delivery.findMany({ where: { tenantId: { in: tenants.map(tenant => tenant.id) } }, select: { eventId: true, tenantId: true, status: true, attemptCount: true } });
      const accepted = requests.filter(request => request.status === 201 && request.eventId);
      return outcomes.length >= accepted.length && outcomes.every(row => ["SUCCEEDED", "DEAD_LETTERED"].includes(row.status));
    }, "load terminal outcomes", config.drainSeconds * 1000);
    durableCompleteAt = Date.now();
    let consecutiveEmpty = 0;
    await waitFor(async () => {
      await Bun.sleep(1500);
      assertProcesses();
      const empty = await db.outbox.count({ where: { published: false } }) === 0 && await queueEmpty();
      consecutiveEmpty = empty ? consecutiveEmpty + 1 : 0;
      return consecutiveEmpty >= 2;
    }, "load queue drain with repeated empty observations", config.drainSeconds * 1000);
    drainedAt = Date.now();
    const accepted = requests.filter(request => request.status === 201 && request.eventId).length;
    await waitFor(async () => {
      assertProcesses();
      for (const [expression, expected] of [
        ['sum(waybill_http_requests_total{job="waybill-api",verification!="true",operation="ingestion",status_class="2xx"})', accepted],
        ['sum(waybill_outbox_publications_total{job="waybill-publisher",verification!="true",outcome="published"})', accepted],
        ['sum(waybill_delivery_terminal_outcomes_total{job="waybill-worker",verification!="true",outcome="succeeded"})', accepted],
      ] as const) {
        const result = await query(expression);
        if (result.length !== 1 || Number(result[0]!.value[1]) !== expected) return false;
      }
      const background = await query('waybill_backlog_sample_success{job="waybill-publisher",verification!="true"}');
      return background.length === 2 && background.every(row => row.value[1] === "1");
    }, "Prometheus stores run counters and successful background samples", 45000);
    await sample();
    outcome = loadReport(requests, receipts, outcomes, limits);
    if (signaturesRejected || unexpected) outcome.failures.push("Receiver observed invalid signatures or unexpected payloads.");
    if (telemetryErrors.length || telemetry.length < 3) outcome.failures.push("Resource collection was incomplete.");
    outcome.passed = outcome.failures.length === 0;
    if (!outcome.passed) throw new Error(outcome.failures.join(" "));
  } catch (error) { failure = error; }
  finally {
    stopSampling = true;
    await sampling;
    const stopped = await Promise.allSettled(children.map(async entry => {
      await stopProcess(entry.child);
      const usage = entry.child.resourceUsage();
      resources.push({ role: entry.role, lifetimeCpuMs: Number(usage?.cpuTime.total ?? 0) / 1000, maxRssBytes: Number(usage?.maxRSS ?? 0) });
    }));
    if (stopped.some(result => result.status === "rejected")) failure ??= new Error("Could not confirm all owned processes stopped");
    try {
      if (fixturesCreated && (!publicationStarted || (!failure && outcome?.passed))) {
        await db.$transaction(async tx => {
          const where = { tenantId: { in: tenants.map(tenant => tenant.id) } };
          await tx.outbox.deleteMany({ where: { event: where } });
          await tx.deadLetter.deleteMany({ where });
          await tx.delivery.deleteMany({ where });
          await tx.event.deleteMany({ where });
          await tx.tenant.deleteMany({ where: { id: { in: tenants.map(tenant => tenant.id) } } });
        }, { timeout: 10000 });
        if (redis.status === "ready") await redis.del(...tenants.flatMap(tenant => [tenantRateLimitKey(tenant.id, "ingestion"), tenantRateLimitKey(tenant.id, "delivery")]), ...(target ? [circuitKeyForTarget(target)] : []));
      } else if (fixturesCreated) console.error(`Accepted work preserved for inspection: ${prefix}`);
    } catch (error) { failure ??= error; }
    try { if (locked) await lock.$queryRaw`SELECT pg_advisory_unlock(728401)`; }
    catch (error) { failure ??= error; }
    redis.disconnect();
    await Promise.all([receiver?.stop(true), db.$disconnect(), lock.$disconnect()]);
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    const report = { runId, prefix, config, startedAt, submissionsFinishedAt, durableCompleteAt, drainedAt,
      finishedAt: Date.now(), passed: !failure && outcome?.passed === true, failure: failure instanceof Error ? failure.message : failure ? String(failure) : null,
      summary: outcome ?? loadReport(requests, receipts, outcomes, limits), signaturesRejected, unexpected,
      completionDrainMs: durableCompleteAt && submissionsFinishedAt ? durableCompleteAt - submissionsFinishedAt : null,
      queueDrainMs: drainedAt && submissionsFinishedAt ? drainedAt - submissionsFinishedAt : null,
      acceptedPerSecond: startedAt && submissionsFinishedAt ? requests.filter(request => request.status === 201).length * 1000 / (submissionsFinishedAt - startedAt) : null,
      durableThroughputPerSecond: startedAt && durableCompleteAt ? outcomes.filter(row => row.status === "SUCCEEDED").length * 1000 / (durableCompleteAt - startedAt) : null,
      queueChecks, telemetrySamples: telemetry.length, telemetryErrors, resources,
      generator: { cpuMicroseconds: process.cpuUsage(), residentMemoryBytes: process.memoryUsage().rss },
      dashboard: `http://127.0.0.1:3300/d/waybill-services?from=${startedAt}&to=${drainedAt || Date.now()}` };
    await Bun.write(`${base}-requests.json`, JSON.stringify(requests, null, 2));
    await Bun.write(`${base}-receipts.json`, JSON.stringify([...receipts], null, 2));
    await Bun.write(`${base}-result.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(`Report: logs/load-${runId}-result.json`);
  }
  if (failure) throw failure;
}

if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
