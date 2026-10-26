import { Counter, Gauge, Histogram, Registry } from "prom-client";

export const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20];
export const WEBHOOK_DURATION_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 20, 30];
export type ServiceRole = "api" | "publisher" | "worker";
export type HttpOperation = "ingestion" | "history" | "summary" | "dead_letters" | "archive" | "replay" | "health" | "unmatched";
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "OTHER";
export type HttpStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "other" | "aborted";

export function createProcessRegistry(service: ServiceRole): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  new Gauge({
    name: "waybill_process_uptime_seconds",
    help: "Elapsed time since process startup in seconds.",
    registers: [registry],
    collect() { this.set(process.uptime()); },
  });
  new Gauge({
    name: "waybill_process_resident_memory_bytes",
    help: "Resident memory used by this process in bytes.",
    registers: [registry],
    collect() { this.set(process.memoryUsage().rss); },
  });
  new Gauge({
    name: "waybill_process_heap_used_bytes",
    help: "Used JavaScript heap in bytes.",
    registers: [registry],
    collect() { this.set(process.memoryUsage().heapUsed); },
  });
  return registry;
}

export function createApiMetrics() {
  const registry = createProcessRegistry("api");
  const requests = new Counter({
    name: "waybill_http_requests_total",
    help: "Completed or aborted API requests, including rejected requests.",
    labelNames: ["operation", "method", "status_class"] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: "waybill_http_request_duration_seconds",
    help: "API request lifetime through response completion or connection closure in seconds.",
    labelNames: ["operation", "method", "status_class"] as const,
    buckets: HTTP_DURATION_BUCKETS,
    registers: [registry],
  });
  return {
    registry,
    observeHttp(operation: HttpOperation, method: HttpMethod, statusClass: HttpStatusClass, seconds: number) {
      const labels = { operation, method, status_class: statusClass };
      requests.inc(labels);
      duration.observe(labels, Math.max(0, seconds));
    },
  };
}

export type ApiMetrics = ReturnType<typeof createApiMetrics>;

export type SqsOperation = "send" | "receive" | "delete" | "change_visibility";
export type OperationOutcome = "success" | "failure";
export type DeferralReason = "circuit_open" | "rate_limit" | "not_due" | "tenant_turn";

function createQueueMetrics(registry: Registry) {
  const operations = new Counter({
    name: "waybill_sqs_operations_total",
    help: "Publishing and delivery SQS operations; incomplete batch confirmations count as failures.",
    labelNames: ["operation", "outcome"] as const,
    registers: [registry],
  });
  return {
    recordSqs(operation: SqsOperation, outcome: OperationOutcome) {
      operations.inc({ operation, outcome });
    },
  };
}

export type QueueMetrics = ReturnType<typeof createQueueMetrics>;

export async function observeSqsOperation<T>(
  metrics: QueueMetrics | undefined,
  operation: SqsOperation,
  send: () => Promise<T>,
  confirmed: (result: T) => boolean = () => true,
): Promise<T> {
  let result: T;
  try {
    result = await send();
  } catch (error) {
    metrics?.recordSqs(operation, "failure");
    throw error;
  }
  metrics?.recordSqs(operation, confirmed(result) ? "success" : "failure");
  return result;
}

export function createPublisherMetrics() {
  const registry = createProcessRegistry("publisher");
  const publications = new Counter({
    name: "waybill_outbox_publications_total",
    help: "Outbox publication results after queue send and database update resolution.",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  return {
    registry,
    ...createQueueMetrics(registry),
    recordPublication(outcome: "published" | "already_published" | "send_failed" | "persist_failed") {
      publications.inc({ outcome });
    },
  };
}

export type PublisherMetrics = ReturnType<typeof createPublisherMetrics>;

export function createWorkerMetrics(bufferedReservations: () => number) {
  const registry = createProcessRegistry("worker");
  const attempts = new Counter({
    name: "waybill_webhook_attempts_total",
    help: "Completed webhook call attempts, excluding preparation failures and completed redeliveries.",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  const durations = new Histogram({
    name: "waybill_webhook_duration_seconds",
    help: "Webhook call attempt duration in seconds.",
    labelNames: ["outcome"] as const,
    buckets: WEBHOOK_DURATION_BUCKETS,
    registers: [registry],
  });
  const retries = new Counter({
    name: "waybill_delivery_retries_total",
    help: "Retry decisions after database update resolution, independent of visibility confirmation.",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  const terminal = new Counter({
    name: "waybill_delivery_terminal_outcomes_total",
    help: "Successful terminal-state database updates, independent of SQS acknowledgements.",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  const deferrals = new Counter({
    name: "waybill_delivery_deferrals_total",
    help: "Receipts with a confirmed visibility deferral, excluding visibility renewals.",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  new Gauge({
    name: "waybill_buffered_reservations",
    help: "Locally tracked buffered receipts with unexpired visibility ownership.",
    registers: [registry],
    collect() { this.set(bufferedReservations()); },
  });
  return {
    registry,
    ...createQueueMetrics(registry),
    recordWebhook(outcome: OperationOutcome, seconds: number) {
      attempts.inc({ outcome });
      durations.observe({ outcome }, Math.max(0, seconds));
    },
    recordRetry(reason: "preparation" | "webhook") { retries.inc({ reason }); },
    recordTerminal(outcome: "succeeded" | "dead_lettered") { terminal.inc({ outcome }); },
    recordDeferral(reason: DeferralReason, count = 1) { deferrals.inc({ reason }, count); },
  };
}

export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>;
