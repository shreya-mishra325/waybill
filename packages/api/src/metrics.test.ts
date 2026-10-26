import { expect, test } from "bun:test";
import express, { type ErrorRequestHandler } from "express";
import { once } from "node:events";
import { createApiMetrics, startMetricsServer } from "@waybill/shared";
import { observeApiRequests } from "./metrics";

test("API metrics count responses once, bound labels, and include parser failures", async () => {
  const metrics = createApiMetrics();
  const app = express();
  app.use(observeApiRequests(metrics));
  app.use(express.json());
  app.post("/events", (_req, res) => res.status(429).json({ error: "limited" }));
  app.get("/tenants/:tenantId/deliveries", (_req, res) => res.status(503).json({ error: "replica unavailable" }));
  app.post("/tenants/:tenantId/dead-letters/:deadLetterId/replay", (_req, res) => res.status(202).json({ accepted: true }));
  const onError: ErrorRequestHandler = (_error, _req, res, _next) => { res.status(400).end(); };
  app.use(onError);
  const api = app.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const url = `http://127.0.0.1:${address.port}`;
  const scrape = startMetricsServer(metrics.registry, { hostname: "127.0.0.1", port: 0 });
  try {
    expect((await fetch(url + "/events", { method: "POST" })).status).toBe(429);
    expect((await fetch(url + "/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status).toBe(400);
    for (const tenant of ["private-tenant-a", "private-tenant-b"]) {
      expect((await fetch(url + `/tenants/${tenant}/deliveries?cursor=private-cursor`)).status).toBe(503);
    }
    expect((await fetch(url + "/tenants/private-tenant-a/dead-letters/private-record/replay", { method: "POST" })).status).toBe(202);
    for (const path of ["/unrecognized/private-one", "/unrecognized/private-two"]) {
      expect((await fetch(url + path)).status).toBe(404);
    }
    const response = await fetch(`http://127.0.0.1:${scrape.port}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    const text = await response.text();
    expect(text).toContain('waybill_http_requests_total{operation="ingestion",method="POST",status_class="4xx",service="api"} 2');
    expect(text).toContain('waybill_http_requests_total{operation="history",method="GET",status_class="5xx",service="api"} 2');
    expect(text).toContain('waybill_http_requests_total{operation="replay",method="POST",status_class="2xx",service="api"} 1');
    expect(text).toContain('waybill_http_requests_total{operation="unmatched",method="GET",status_class="4xx",service="api"} 2');
    const histogram = (await metrics.registry.getMetricsAsJSON()).find(metric => metric.name === "waybill_http_request_duration_seconds");
    const ingestionCount = histogram?.values.find(value => "metricName" in value && value.metricName === "waybill_http_request_duration_seconds_count" && value.labels.operation === "ingestion");
    expect(ingestionCount?.value).toBe(2);
    expect(text).toContain("waybill_process_resident_memory_bytes");
    expect(text).not.toContain("private-");
    expect(text).not.toContain('status_class="aborted"');
    expect((await fetch(url + "/metrics")).status).toBe(404);
    await scrape.stop(true);
    expect((await fetch(url + "/events", { method: "POST" })).status).toBe(429);
  } finally {
    await scrape.stop(true);
    await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  }
});

test("API metrics record a disconnected response as aborted once", async () => {
  const metrics = createApiMetrics();
  const app = express();
  app.use(observeApiRequests(metrics));
  let closed!: () => void;
  const connectionClosed = new Promise<void>(resolve => { closed = resolve; });
  app.get("/tenants/:tenantId/deliveries", (_req, res) => {
    res.once("close", closed);
    res.destroy();
  });
  const api = app.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  try {
    await expect(fetch(`http://127.0.0.1:${address.port}/tenants/private-tenant/deliveries`, {
      signal: AbortSignal.timeout(2000),
    })).rejects.toBeDefined();
    await connectionClosed;
    const text = await metrics.registry.metrics();
    expect(text).toContain('waybill_http_requests_total{operation="history",method="GET",status_class="aborted",service="api"} 1');
    expect(text).not.toContain('status_class="2xx"');
  } finally {
    await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  }
});
