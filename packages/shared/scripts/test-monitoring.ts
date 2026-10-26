import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApiMetrics, createPublisherMetrics, createWorkerMetrics, createBacklogMetrics, startMetricsServer } from "../src/index";

const root = resolve(import.meta.dir, "../../..");
const user = process.env.GRAFANA_ADMIN_USER;
const password = process.env.GRAFANA_ADMIN_PASSWORD;
if (!user || !password) throw new Error("Run with bun --env-file=.env.monitoring");
const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const api = createApiMetrics();
const publisher = createPublisherMetrics();
const worker = createWorkerMetrics(() => 3);
const backlog = createBacklogMetrics(publisher.registry);
for (const [service, metrics] of [["api", api], ["publisher", publisher], ["worker", worker]] as const) {
  metrics.registry.setDefaultLabels({ service, verification: "true" });
}
const servers: ReturnType<typeof startMetricsServer>[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let tick = 0;

function traffic() {
  api.observeHttp("ingestion", "POST", "2xx", 0.02);
  worker.recordWebhook("success", 0.05);
  worker.recordTerminal("succeeded");
  worker.recordSqs("receive", "success");
  worker.recordSqs("delete", "success");
  publisher.recordSqs("send", "success");
  publisher.recordPublication("published");
  if (tick % 3 === 0) {
    api.observeHttp("ingestion", "POST", "4xx", 0.005);
    worker.recordWebhook("failure", 0.1);
    worker.recordRetry("webhook");
    worker.recordDeferral("rate_limit");
  }
  if (tick % 7 === 0) worker.recordTerminal("dead_lettered");
  backlog.recordOutbox(10, Date.now() / 1000);
  backlog.recordQueue({ visible: 7, in_flight: 3, delayed: 1 }, Date.now() / 1000);
  tick++;
}

type PromResponse = { status: string; error?: string; data: { result: { metric: Record<string, string>; value: [number, string] }[] } };
async function query(expression: string): Promise<PromResponse> {
  const response = await fetch(`http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(expression)}`, { signal: AbortSignal.timeout(5000) });
  const body = await response.json() as PromResponse;
  if (!response.ok || body.status !== "success") throw new Error(`Prometheus query failed: ${body.error ?? expression}`);
  return body;
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 75000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(1000);
  }
}
async function grafana(path: string) {
  return fetch(`http://127.0.0.1:3300${path}`, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(5000) });
}

console.log("Starting controlled metric fixtures; no database, Redis, SQS, or S3 operations will run.");
try {
  for (const [port, metrics] of [[9100, api], [9101, publisher], [9102, worker]] as const) {
    servers.push(startMetricsServer(metrics.registry, { hostname: "127.0.0.1", port }));
  }
  traffic();
  timer = setInterval(traffic, 1000);
  await until(async () => {
    const result = await query('up{job=~"waybill-(api|publisher|worker)"}');
    return result.data.result.length === 3 && result.data.result.every(value => value.value[1] === "1");
  }, "all scrape targets up");
  console.log("PASS: all three Prometheus scrape targets are up");

  await until(async () => (await query('sum(rate(waybill_webhook_attempts_total{verification="true"}[1m]))')).data.result.length > 0, "rate data after two scrapes");
  await until(async () => (await query("waybill:outbox_pending:fresh")).data.result[0]?.value[1] === "10", "fresh backlog rule evaluation");

  const dashboard = JSON.parse(await readFile(resolve(root, "infra/monitoring/grafana/dashboards/waybill-services.json"), "utf8")) as {
    panels: { title: string; targets: { expr: string }[] }[];
  };
  for (const panel of dashboard.panels) {
    for (const target of panel.targets) {
      const result = await query(target.expr.replaceAll("$__rate_interval", "1m"));
      if (!result.data.result.length) throw new Error(`Dashboard query has no fixture data: ${panel.title}`);
    }
  }
  console.log(`PASS: all ${dashboard.panels.length} dashboard panels have queryable controlled data`);

  const anonymous = await fetch("http://127.0.0.1:3300/api/dashboards/uid/waybill-services", { signal: AbortSignal.timeout(5000) });
  if (anonymous.status !== 401) throw new Error("Grafana dashboard should require authentication");
  const provisioned = await grafana("/api/dashboards/uid/waybill-services");
  if (!provisioned.ok) throw new Error("Provisioned Grafana dashboard not available");
  const body = await provisioned.json() as { dashboard: { panels: unknown[] }; meta: { provisioned: boolean } };
  if (!body.meta.provisioned || body.dashboard.panels.length !== dashboard.panels.length) throw new Error("Dashboard provisioning mismatch");
  const health = await grafana("/api/datasources/uid/waybill-prometheus/health");
  if (!health.ok) throw new Error("Grafana Prometheus data source health failed");
  const proxy = await grafana("/api/datasources/proxy/uid/waybill-prometheus/api/v1/query?query=waybill%3Aoutbox_pending%3Afresh");
  if (!proxy.ok) throw new Error("Grafana data source proxy query failed");
  const proxyData = await proxy.json() as PromResponse;
  if (proxyData.data.result[0]?.value[1] !== "10") throw new Error("Grafana data source proxy returned incorrect backlog");
  console.log("PASS: Grafana authentication, dashboard provisioning, data source health, and proxy query");
} finally {
  if (timer) clearInterval(timer);
  await Promise.all(servers.map(server => server.stop(true)));
}
await until(async () => {
  const result = await query('up{job=~"waybill-(api|publisher|worker)"}');
  return result.data.result.length === 3 && result.data.result.every(value => value.value[1] === "0");
}, "missing targets are visible after fixture shutdown");
await until(async () => (await query("waybill:outbox_pending:fresh")).data.result.length === 0, "down targets suppress stale backlog");
console.log("PASS: missing targets are DOWN and fresh backlog becomes absent rather than zero");
console.log("Controlled monitoring verification complete; fixture listeners stopped.");
