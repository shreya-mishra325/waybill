import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { createSqsClient } from "../src/aws";
import { fairnessReport, type Sample } from "./fairness-report";

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const backlogMode = process.argv.includes("--backlog");
  if (process.argv.includes("--help")) {
    console.log(`Start the API and poller, and stop dev:receiver before running.
Burst mode also needs an external worker. Backlog mode (--backlog) owns its worker.
This command creates test tenants and sends real events through the configured AWS queue.
Burst defaults: 10,000 busy requests, 20 concurrent requests, 10-minute timeout.
Backlog defaults: 1,000 fully accepted busy requests, 20 concurrent requests, 15-minute timeout.
Both modes submit one quiet request per second and require quiet p95 within 30 seconds.
Options via env: FAIRNESS_BUSY_REQUESTS, FAIRNESS_CONCURRENCY, FAIRNESS_QUIET_INTERVAL_MS,
FAIRNESS_QUIET_P95_MS, FAIRNESS_TIMEOUT_MS, FAIRNESS_REPORT_PATH, API_URL, RECEIVER_URL.
For backlog mode, raise the test API ingestion budget to accept the complete preload.
Keep delivery budgets unchanged. The queue must be empty before the run.
See docs/PHASE_5_NOTES.md for setup and result interpretation.`);
    return;
  }

  const config = {
    busyRequests: positiveInteger("FAIRNESS_BUSY_REQUESTS", backlogMode ? 1000 : 10_000),
    concurrency: positiveInteger("FAIRNESS_CONCURRENCY", 20),
    quietIntervalMs: positiveInteger("FAIRNESS_QUIET_INTERVAL_MS", 1000),
    quietP95Ms: positiveInteger("FAIRNESS_QUIET_P95_MS", 30_000),
    timeoutMs: positiveInteger("FAIRNESS_TIMEOUT_MS", backlogMode ? 900_000 : 600_000),
  };
  const apiUrl = new URL(process.env.API_URL ?? "http://127.0.0.1:3000/events");
  const receiverUrl = new URL(process.env.RECEIVER_URL ?? "http://127.0.0.1:4000/webhook");
  for (const url of [apiUrl, receiverUrl]) {
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
      throw new Error("The fairness runner requires local HTTP API and receiver URLs.");
    }
  }
  const runId = crypto.randomUUID();
  const reportPath = process.env.FAIRNESS_REPORT_PATH ?? `logs/fairness-${runId}.json`;
  const samples: Sample[] = [];
  const receipts = new Map<string, number>();
  const tenantIds = new Set<string>();
  let duplicates = 0;
  let unrelated = 0;
  let receiverErrors = 0;
  let busyFinishedAt = 0;
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  let backlogEvidence: { publishedBeforeStart: number; visibleBeforeStart: number } | undefined;

  function startWorker() {
    worker = Bun.spawn([process.execPath, "run", "packages/worker/src/index.ts"], {
      env: { ...process.env, RECEIVER_URL: receiverUrl.toString() },
      stdout: Bun.file(`logs/fairness-worker-${runId}.log`),
      stderr: Bun.file(`logs/fairness-worker-${runId}.error.log`),
    });
  }

  async function stopWorker() {
    const current = worker;
    if (!current) return;
    current.kill("SIGTERM");
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([current.exited, new Promise<void>((resolve) => {
        killTimer = setTimeout(() => { current.kill("SIGKILL"); resolve(); }, 5000);
      })]);
    } finally {
      if (killTimer) clearTimeout(killTimer);
      worker = undefined;
    }
  }

  process.once("exit", () => { worker?.kill("SIGTERM"); });
  let deadline = Date.now() + config.timeoutMs;
  let timedOut = false;
  let fatalError: string | undefined;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      fatalError = `Interrupted by ${signal}`;
      deadline = Date.now();
      worker?.kill("SIGTERM");
    });
  }

  const health = await fetch(new URL("/health", apiUrl), { signal: AbortSignal.timeout(5000) });
  await health.text();
  if (!health.ok) throw new Error(`API health check returned ${health.status}`);

  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  databaseUrl.searchParams.set("connect_timeout", "5");
  databaseUrl.searchParams.set("pool_timeout", "5");
  databaseUrl.searchParams.set("socket_timeout", "10");
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });

  const receiver = Bun.serve({
    hostname: receiverUrl.hostname,
    port: Number(receiverUrl.port || 80),
    idleTimeout: 10,
    async fetch(req: Request): Promise<Response> {
      if (req.method !== "POST" || new URL(req.url).pathname !== receiverUrl.pathname) {
        return new Response("not found", { status: 404 });
      }
      try {
        const body: unknown = await req.json();
        if (record(body) && record(body.payload) && body.payload.runId === runId &&
            typeof body.tenantId === "string" && tenantIds.has(body.tenantId) &&
            typeof body.eventId === "string") {
          if (receipts.has(body.eventId)) duplicates++;
          else receipts.set(body.eventId, Date.now());
        } else {
          unrelated++;
        }
        return Response.json({ ok: true });
      } catch (err) {
        receiverErrors++;
        console.error("receiver could not parse request", err instanceof Error ? err.message : String(err));
        return new Response("invalid JSON", { status: 400 });
      }
    },
  });

  async function queueCounts() {
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl) throw new Error("SQS_QUEUE_URL is required");
    const result = await createSqsClient().send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"],
    }), { abortSignal: AbortSignal.timeout(8000) });
    const values = result.Attributes ?? {};
    return {
      visible: Number(values.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(values.ApproximateNumberOfMessagesNotVisible ?? 0),
      delayed: Number(values.ApproximateNumberOfMessagesDelayed ?? 0),
    };
  }

  const timer = setInterval(() => {
    console.log(JSON.stringify({ submitted: samples.length, received: receipts.size, duplicates }));
  }, 10_000);

  async function submit(tenant: Sample["tenant"], phase: Sample["phase"], tenantId: string) {
    if (Date.now() >= deadline) { timedOut = true; return; }
    const sample: Sample = { tenant, phase, sentAt: Date.now() };
    if (backlogMode && phase === "load" && tenant === "quiet") {
      sample.busyPendingAtSubmission = samples.filter((s) =>
        s.tenant === "busy" && s.eventId && !receipts.has(s.eventId)).length;
    }
    samples.push(sample);
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, type: "fairness.test", payload: { runId, tenant, phase } }),
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
      });
      sample.status = response.status;
      const text = await response.text();
      if (response.status === 201) {
        const body: unknown = JSON.parse(text);
        if (!record(body) || typeof body.eventId !== "string") throw new Error("201 response missing eventId");
        sample.eventId = body.eventId;
      } else if (response.status !== 429) {
        sample.error = `HTTP ${response.status}`;
      }
    } catch (err) {
      sample.error = err instanceof Error ? err.message : String(err);
    }
  }

  async function waitForAccepted(selected: Sample[], until: number) {
    while (selected.some((sample) => sample.eventId && !receipts.has(sample.eventId))) {
      if (Date.now() >= until) return false;
      await sleep(Math.min(250, Math.max(1, until - Date.now())));
    }
    return true;
  }

  console.log(JSON.stringify({ runId, mode: backlogMode ? "backlog" : "burst", config, reportPath, receiver: receiverUrl.toString() }));
  try {
    if (backlogMode) {
      const counts = await queueCounts();
      const pending = await db.outbox.count({ where: { published: false } });
      if (counts.visible || counts.inFlight || counts.delayed || pending) {
        throw new Error("Backlog mode requires an empty development queue and no pending outbox rows. Drain existing work first.");
      }
    }
    const tenants = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
      const busy = await tx.tenant.create({ data: { name: `fairness-busy-${runId}`, hmacSecret: crypto.randomUUID() } });
      const quiet = await tx.tenant.create({ data: { name: `fairness-quiet-${runId}`, hmacSecret: crypto.randomUUID() } });
      return { busy, quiet };
    }, { maxWait: 5000, timeout: 10_000 });
    tenantIds.add(tenants.busy.id);
    tenantIds.add(tenants.quiet.id);

    if (backlogMode) startWorker();
    for (let i = 0; i < 3; i++) {
      await submit("quiet", "baseline", tenants.quiet.id);
      await sleep(config.quietIntervalMs);
    }
    if (!await waitForAccepted(samples, Math.min(deadline, Date.now() + config.quietP95Ms)) ||
        samples.length !== 3 || samples.some((s) => s.status !== 201 || s.error)) {
      throw new Error("Baseline failed. Check API, poller, worker, and receiver configuration before generating load.");
    }

    if (backlogMode) {
      const until = Math.min(deadline, Date.now() + 60_000);
      while (true) {
        const counts = await queueCounts();
        if (!counts.visible && !counts.inFlight && !counts.delayed) break;
        if (Date.now() >= until) throw new Error("Baseline queue did not drain before preloading");
        await sleep(1000);
      }
      await stopWorker();
    }

    let next = 0;
    let busyDone = false;
    const busy = Promise.all(Array.from({ length: Math.min(config.concurrency, config.busyRequests) }, async () => {
      while (next < config.busyRequests && Date.now() < deadline) {
        next++;
        await submit("busy", "load", tenants.busy.id);
      }
    })).finally(() => { busyFinishedAt = Date.now(); busyDone = true; });
    if (backlogMode) {
      await busy;
      const busySamples = samples.filter((s) => s.tenant === "busy");
      if (busySamples.length !== config.busyRequests || busySamples.some((s) => s.status !== 201 || s.error)) {
        throw new Error("Backlog preload requires every busy request to be accepted. Check the test API ingestion budget.");
      }
      while (Date.now() < deadline) {
        const published = await db.outbox.count({ where: {
          published: true, event: { tenantId: tenants.busy.id },
        } });
        const counts = await queueCounts();
        if (published === config.busyRequests && counts.visible >= config.busyRequests && !counts.inFlight) {
          backlogEvidence = { publishedBeforeStart: published, visibleBeforeStart: counts.visible };
          break;
        }
        await sleep(1000);
      }
      if (!backlogEvidence) throw new Error("Timed out confirming the published backlog before worker start");
      console.log(JSON.stringify({ backlogEvidence }));
      startWorker();
    }
    const quiet = (async () => {
      let submitted = 0;
      while ((backlogMode
        ? samples.some((s) => s.tenant === "busy" && s.eventId && !receipts.has(s.eventId)) || submitted < 3
        : !busyDone || submitted < 3) && Date.now() < deadline) {
        if (backlogMode && worker?.exitCode !== null) throw new Error("Worker exited unexpectedly");
        await submit("quiet", "load", tenants.quiet.id);
        submitted++;
        await sleep(config.quietIntervalMs);
      }
    })();
    await Promise.all([busy, quiet]);
    if (!await waitForAccepted(samples, deadline) || Date.now() >= deadline) timedOut = true;
    if (backlogMode && !timedOut) {
      while (true) {
        const counts = await queueCounts();
        if (!counts.visible && !counts.inFlight && !counts.delayed) break;
        if (Date.now() >= deadline) { timedOut = true; break; }
        if (worker?.exitCode !== null) throw new Error("Worker exited before queue drain");
        await sleep(1000);
      }
    }
  } catch (err) {
    fatalError = err instanceof Error ? err.message : String(err);
  } finally {
    clearInterval(timer);
    try {
      await stopWorker();
    } finally {
      receiver.stop(true);
      await db.$disconnect();
    }
  }

  const evaluation = fairnessReport(samples, receipts, {
    ...config, busyFinishedAt,
    backlog: backlogMode ? backlogEvidence ?? { publishedBeforeStart: 0, visibleBeforeStart: 0 } : undefined,
  });
  const passed = evaluation.passed && !timedOut && !fatalError && receiverErrors === 0 &&
    (!backlogMode || unrelated === 0);
  const report = {
    mode: backlogMode ? "backlog" : "burst", backlogEvidence,
    runId, finishedAt: new Date().toISOString(), config, tenantIds: [...tenantIds],
    ...evaluation, passed, timedOut, fatalError, duplicates, unrelated, receiverErrors,
    samples, receipts: Object.fromEntries(receipts),
  };
  await Bun.write(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...evaluation, passed, timedOut, fatalError, reportPath }, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("fairness test failed", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
