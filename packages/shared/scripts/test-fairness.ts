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
  if (process.argv.includes("--help")) {
    console.log(`Run with API, poller, and worker already started. Stop dev:receiver first.
This command creates two tenants and sends real events through the configured AWS queue.
Defaults: 10,000 busy requests, 20 concurrent requests, one quiet request per second,
30-second quiet p95 limit, 10-minute overall timeout.
Options via env: FAIRNESS_BUSY_REQUESTS, FAIRNESS_CONCURRENCY, FAIRNESS_QUIET_INTERVAL_MS,
FAIRNESS_QUIET_P95_MS, FAIRNESS_TIMEOUT_MS, FAIRNESS_REPORT_PATH, API_URL, RECEIVER_URL.
See docs/PHASE_5_NOTES.md for setup and result interpretation.`);
    return;
  }

  const config = {
    busyRequests: positiveInteger("FAIRNESS_BUSY_REQUESTS", 10_000),
    concurrency: positiveInteger("FAIRNESS_CONCURRENCY", 20),
    quietIntervalMs: positiveInteger("FAIRNESS_QUIET_INTERVAL_MS", 1000),
    quietP95Ms: positiveInteger("FAIRNESS_QUIET_P95_MS", 30_000),
    timeoutMs: positiveInteger("FAIRNESS_TIMEOUT_MS", 600_000),
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
  const deadline = Date.now() + config.timeoutMs;
  let timedOut = false;
  let fatalError: string | undefined;

  const health = await fetch(new URL("/health", apiUrl), { signal: AbortSignal.timeout(5000) });
  await health.text();
  if (!health.ok) throw new Error(`API health check returned ${health.status}`);

  // Bound both connection establishment and query execution in this standalone runner.
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  databaseUrl.searchParams.set("connect_timeout", "5");
  databaseUrl.searchParams.set("pool_timeout", "5");
  databaseUrl.searchParams.set("socket_timeout", "10");
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });

  // This receiver measures first arrival, independently of worker database timestamps.
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

  const timer = setInterval(() => {
    console.log(JSON.stringify({ submitted: samples.length, received: receipts.size, duplicates }));
  }, 10_000);

  async function submit(tenant: Sample["tenant"], phase: Sample["phase"], tenantId: string) {
    if (Date.now() >= deadline) { timedOut = true; return; }
    const sample: Sample = { tenant, phase, sentAt: Date.now() };
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
      // A timeout can occur after an event commits. Do not retry and double-count it.
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

  console.log(JSON.stringify({ runId, config, reportPath, receiver: receiverUrl.toString() }));
  try {
    const tenants = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
      const busy = await tx.tenant.create({ data: { name: `fairness-busy-${runId}`, hmacSecret: crypto.randomUUID() } });
      const quiet = await tx.tenant.create({ data: { name: `fairness-quiet-${runId}`, hmacSecret: crypto.randomUUID() } });
      return { busy, quiet };
    }, { maxWait: 5000, timeout: 10_000 });
    tenantIds.add(tenants.busy.id);
    tenantIds.add(tenants.quiet.id);

    for (let i = 0; i < 3; i++) {
      await submit("quiet", "baseline", tenants.quiet.id);
      await sleep(config.quietIntervalMs);
    }
    if (!await waitForAccepted(samples, Math.min(deadline, Date.now() + config.quietP95Ms)) ||
        samples.length !== 3 || samples.some((s) => s.status !== 201 || s.error)) {
      throw new Error("Baseline failed. Check API, poller, worker, and receiver configuration before generating load.");
    }

    let next = 0;
    let busyDone = false;
    const busy = Promise.all(Array.from({ length: Math.min(config.concurrency, config.busyRequests) }, async () => {
      while (next < config.busyRequests && Date.now() < deadline) {
        next++;
        await submit("busy", "load", tenants.busy.id);
      }
    })).finally(() => { busyFinishedAt = Date.now(); busyDone = true; });
    const quiet = (async () => {
      let submitted = 0;
      while ((!busyDone || submitted < 3) && Date.now() < deadline) {
        await submit("quiet", "load", tenants.quiet.id);
        submitted++;
        await sleep(config.quietIntervalMs);
      }
    })();
    await Promise.all([busy, quiet]);
    if (!await waitForAccepted(samples, deadline) || Date.now() >= deadline) timedOut = true;
  } catch (err) {
    fatalError = err instanceof Error ? err.message : String(err);
  } finally {
    clearInterval(timer);
    receiver.stop(true);
    await db.$disconnect();
  }

  const evaluation = fairnessReport(samples, receipts, { ...config, busyFinishedAt });
  const passed = evaluation.passed && !timedOut && !fatalError && receiverErrors === 0;
  const report = {
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
