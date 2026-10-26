import { expect, spyOn, test } from "bun:test";
import { createApiMetrics, createProcessRegistry, createWorkerMetrics, observeSqsOperation } from "./metrics";
import { metricsServerOptions, startMetricsServer } from "./metrics-server";

test("metric registries remain independent between instances and service roles", async () => {
  const first = createApiMetrics();
  const second = createApiMetrics();
  first.observeHttp("ingestion", "POST", "2xx", 0.125);
  const output = await first.registry.metrics();
  const histogram = (await first.registry.getMetricsAsJSON()).find(metric => metric.name === "waybill_http_request_duration_seconds");
  expect(histogram?.values.find(value => "metricName" in value && value.metricName === "waybill_http_request_duration_seconds_sum")?.value).toBe(0.125);
  expect(output).toContain('le="0.25"');
  expect(await second.registry.metrics()).not.toContain('operation="ingestion"');
  const worker = await createProcessRegistry("worker").metrics();
  expect(worker).toContain('service="worker"');
  expect(worker).not.toContain("waybill_http_requests_total");
});

test("metrics are opt-in and reject public addresses and invalid ports", () => {
  expect(metricsServerOptions({}, 9100)).toBeUndefined();
  expect(metricsServerOptions({ METRICS_ENABLED: "false" }, 9100)).toBeUndefined();
  expect(metricsServerOptions({ METRICS_ENABLED: "true" }, 9100)).toEqual({ hostname: "127.0.0.1", port: 9100 });
  for (const port of ["0", "-1", "65536", "NaN", "1.5", ""]) {
    expect(() => metricsServerOptions({ METRICS_ENABLED: "true", API_METRICS_PORT: port }, 9100)).toThrow();
  }
  expect(() => metricsServerOptions({ METRICS_ENABLED: "true", METRICS_HOST: "0.0.0.0" }, 9100)).toThrow();
});

test("metrics listener serves only GET /metrics and reports collection failure", async () => {
  const registry = createProcessRegistry("api");
  const server = startMetricsServer(registry, { hostname: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(url + "/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.text())).toContain("waybill_process_uptime_seconds");
    expect((await fetch(url + "/health")).status).toBe(404);
    const post = await fetch(url + "/metrics", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET");
    const log = spyOn(console, "error").mockImplementation(() => {});
    registry.metrics = async () => { throw new Error("test collection failure"); };
    try {
      const failure = await fetch(url + "/metrics");
      expect(failure.status).toBe(503);
      expect(await failure.text()).toBe("Metrics unavailable");
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  } finally {
    await server.stop(true);
  }
});

test("worker collection samples local buffered ownership and separates SQS receive outcomes", async () => {
  let owned = 3;
  const metrics = createWorkerMetrics(() => owned);
  const response = { messages: [] };
  expect(await observeSqsOperation(metrics, "receive", async () => response)).toBe(response);
  const failure = new Error("receive unavailable");
  await expect(observeSqsOperation(metrics, "receive", async () => { throw failure; })).rejects.toBe(failure);
  expect(await metrics.registry.metrics()).toContain('waybill_buffered_reservations{service="worker"} 3');
  owned = 0;
  const output = await metrics.registry.metrics();
  expect(output).toContain('waybill_buffered_reservations{service="worker"} 0');
  expect(output).toContain('waybill_sqs_operations_total{operation="receive",outcome="success",service="worker"} 1');
  expect(output).toContain('waybill_sqs_operations_total{operation="receive",outcome="failure",service="worker"} 1');
  expect(output).not.toContain('waybill_webhook_attempts_total{');
});

test("publisher and worker metrics use their own port variables", () => {
  const env = { METRICS_ENABLED: "true", API_METRICS_PORT: "9100", PUBLISHER_METRICS_PORT: "9201", WORKER_METRICS_PORT: "9202" };
  expect(metricsServerOptions(env, 9101, "PUBLISHER_METRICS_PORT")?.port).toBe(9201);
  expect(metricsServerOptions(env, 9102, "WORKER_METRICS_PORT")?.port).toBe(9202);
  expect(() => metricsServerOptions({ ...env, WORKER_METRICS_PORT: "bad" }, 9102, "WORKER_METRICS_PORT")).toThrow("WORKER_METRICS_PORT");
});
