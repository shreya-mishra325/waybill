import { expect, test } from "bun:test";
import { createBacklogMetrics, createPublisherMetrics, startMetricsServer, type QueueDepth } from "@waybill/shared";
import { startBacklogSampler } from "./backlog-sampler";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 1000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for sampler test");
    await Bun.sleep(2);
  }
}

function fixture() {
  const { registry } = createPublisherMetrics();
  const metrics = createBacklogMetrics(registry);
  async function value(name: string, labels: Record<string, string> = {}) {
    const metric = (await registry.getMetricsAsJSON()).find(metric => metric.name === name);
    return metric?.values.find(entry => Object.entries(labels).every(([key, value]) => entry.labels[key] === value))?.value;
  }
  return { registry, metrics, value };
}

test("backlog starts unknown, validates counts atomically, and preserves last good samples", async () => {
  const { metrics, value } = fixture();
  expect(Number.isNaN(await value("waybill_outbox_pending"))).toBe(true);
  expect(Number.isNaN(await value("waybill_sqs_messages", { state: "visible" }))).toBe(true);
  expect(await value("waybill_backlog_sample_success", { source: "sqs" })).toBe(0);
  expect(await value("waybill_backlog_sample_timestamp_seconds", { source: "sqs" })).toBe(0);
  metrics.recordOutbox(5, 100);
  metrics.recordQueue({ visible: 3, in_flight: 2, delayed: 1 }, 100);
  metrics.recordFailure("sqs");
  expect(await value("waybill_sqs_messages", { state: "visible" })).toBe(3);
  expect(await value("waybill_backlog_sample_timestamp_seconds", { source: "sqs" })).toBe(100);
  expect(await value("waybill_backlog_sample_success", { source: "outbox" })).toBe(1);
  expect(() => metrics.recordQueue({ visible: 50, in_flight: -1, delayed: 0 }, 200)).toThrow();
  expect(await value("waybill_sqs_messages", { state: "visible" })).toBe(3);
  for (const invalid of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => metrics.recordOutbox(invalid, 200)).toThrow();
  }
  metrics.recordQueue({ visible: 0, in_flight: 0, delayed: 0 }, 200);
  expect(await value("waybill_backlog_sample_success", { source: "sqs" })).toBe(1);
  expect(await value("waybill_backlog_sample_timestamp_seconds", { source: "sqs" })).toBe(200);
  expect(await value("waybill_sqs_messages", { state: "visible" })).toBe(0);
});

test("scrapes use cached values without starting database or queue requests", async () => {
  const { metrics, registry, value } = fixture();
  let outboxReads = 0;
  let queueReads = 0;
  const sampler = startBacklogSampler({
    metrics, intervalMs: 10000, now: () => 100000,
    readOutbox: async () => { outboxReads++; return 7; },
    readQueue: async () => { queueReads++; return { visible: 4, in_flight: 2, delayed: 1 }; },
    onError: (_source, error) => { throw error; },
  });
  const server = startMetricsServer(registry, { hostname: "127.0.0.1", port: 0 });
  try {
    await until(async () => await value("waybill_backlog_sample_success", { source: "sqs" }) === 1);
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('waybill_outbox_pending{service="publisher"} 7');
    }
    expect(outboxReads).toBe(1);
    expect(queueReads).toBe(1);
    expect(await value("waybill_backlog_sample_timestamp_seconds", { source: "outbox" })).toBe(100);
  } finally {
    await sampler.stop();
    await server.stop(true);
  }
});

test("deadline marks failure without overlap and late results cannot overwrite the cache", async () => {
  const { metrics, value } = fixture();
  const first = deferred<number>();
  const second = deferred<number>();
  let reads = 0;
  let queueReads = 0;
  const errors: string[] = [];
  const sampler = startBacklogSampler({
    metrics, intervalMs: 5, timeoutMs: 30,
    readOutbox: async () => { reads++; return reads === 1 ? first.promise : second.promise; },
    readQueue: async () => { queueReads++; return { visible: 0, in_flight: 0, delayed: 0 }; },
    onError: source => { errors.push(source); },
  });
  try {
    await until(() => errors.includes("outbox") && queueReads >= 3);
    expect(reads).toBe(1);
    expect(errors.filter(source => source === "outbox")).toHaveLength(1);
    first.resolve(999);
    await until(() => reads === 2);
    expect(Number.isNaN(await value("waybill_outbox_pending"))).toBe(true);
    second.resolve(8);
    await until(async () => await value("waybill_outbox_pending") === 8);
    expect(await value("waybill_backlog_sample_success", { source: "outbox" })).toBe(1);
  } finally {
    first.resolve(999);
    second.resolve(8);
    await sampler.stop();
  }
});

test("one source can fail and recover without stopping the other", async () => {
  const { metrics, value } = fixture();
  const gates = [deferred<QueueDepth>(), deferred<QueueDepth>(), deferred<QueueDepth>()];
  let reads = 0;
  let now = 100000;
  let outboxReads = 0;
  const sampler = startBacklogSampler({
    metrics, intervalMs: 5, timeoutMs: 1000, now: () => now,
    readOutbox: async () => { outboxReads++; return 2; },
    readQueue: async () => gates[Math.min(reads++, 2)].promise,
    onError: () => {},
  });
  try {
    gates[0].resolve({ visible: 4, in_flight: 2, delayed: 1 });
    await until(async () => await value("waybill_backlog_sample_success", { source: "sqs" }) === 1);
    await until(() => reads === 2);
    gates[1].reject(new Error("AWS unavailable"));
    await until(async () => await value("waybill_backlog_sample_success", { source: "sqs" }) === 0);
    expect(await value("waybill_sqs_messages", { state: "visible" })).toBe(4);
    expect(await value("waybill_backlog_sample_timestamp_seconds", { source: "sqs" })).toBe(100);
    expect(await value("waybill_backlog_sample_success", { source: "outbox" })).toBe(1);
    now = 200000;
    gates[2].resolve({ visible: 0, in_flight: 0, delayed: 0 });
    await until(async () => await value("waybill_backlog_sample_success", { source: "sqs" }) === 1);
    expect(await value("waybill_backlog_sample_timestamp_seconds", { source: "sqs" })).toBe(200);
    expect(outboxReads).toBeGreaterThan(1);
  } finally {
    for (const gate of gates) gate.resolve({ visible: 0, in_flight: 0, delayed: 0 });
    await sampler.stop();
  }
});

test("stop aborts pending reads, waits for them, and prevents rescheduling or late updates", async () => {
  const { metrics, value } = fixture();
  const signals: AbortSignal[] = [];
  async function pending(signal: AbortSignal): Promise<never> {
    signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }
  const errors: unknown[] = [];
  const sampler = startBacklogSampler({ metrics, readOutbox: pending, readQueue: pending,
    intervalMs: 5, onError: (_source, error) => { errors.push(error); } });
  await until(() => signals.length === 2);
  await sampler.stop();
  await Bun.sleep(15);
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(signals).toHaveLength(2);
  expect(errors).toHaveLength(0);
  expect(Number.isNaN(await value("waybill_outbox_pending"))).toBe(true);
});
