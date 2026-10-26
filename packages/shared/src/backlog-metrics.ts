import { Gauge, type Registry } from "prom-client";

export type BacklogSource = "outbox" | "sqs";
export type QueueDepth = { visible: number; in_flight: number; delayed: number };

export function validateBacklogCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Backlog count must be a nonnegative safe integer");
  return value;
}

export function createBacklogMetrics(registry: Registry) {
  const pending = new Gauge({
    name: "waybill_outbox_pending",
    help: "Unpublished outbox rows at the last successful background sample.",
    registers: [registry],
  });
  const queue = new Gauge({
    name: "waybill_sqs_messages",
    help: "Approximate SQS depth at the last successful background sample.",
    labelNames: ["state"] as const,
    registers: [registry],
  });
  const success = new Gauge({
    name: "waybill_backlog_sample_success",
    help: "Whether the latest background sample succeeded; zero before the first success.",
    labelNames: ["source"] as const,
    registers: [registry],
  });
  const timestamp = new Gauge({
    name: "waybill_backlog_sample_timestamp_seconds",
    help: "Unix time of the last successful background sample; zero before the first success.",
    labelNames: ["source"] as const,
    registers: [registry],
  });
  pending.set(Number.NaN);
  for (const state of ["visible", "in_flight", "delayed"] as const) queue.set({ state }, Number.NaN);
  for (const source of ["outbox", "sqs"] as const) {
    success.set({ source }, 0);
    timestamp.set({ source }, 0);
  }
  function completed(source: BacklogSource, at: number) {
    timestamp.set({ source }, at);
    success.set({ source }, 1);
  }
  return {
    recordOutbox(count: number, at: number) {
      validateBacklogCount(count);
      pending.set(count);
      completed("outbox", at);
    },
    recordQueue(depth: QueueDepth, at: number) {
      for (const value of Object.values(depth)) validateBacklogCount(value);
      queue.set({ state: "visible" }, depth.visible);
      queue.set({ state: "in_flight" }, depth.in_flight);
      queue.set({ state: "delayed" }, depth.delayed);
      completed("sqs", at);
    },
    recordFailure(source: BacklogSource) { success.set({ source }, 0); },
  };
}

export type BacklogMetrics = ReturnType<typeof createBacklogMetrics>;
