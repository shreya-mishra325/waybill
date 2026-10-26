import { expect, mock } from "bun:test";
import type { Message } from "@aws-sdk/client-sqs";
import type { UnpublishedOutbox } from "./repositories/outbox";

const scenario = process.argv[2];
const shared = { ...await import("@waybill/shared") };
const circuit = { ...await import("./delivery/circuit-breaker") };
let status = 204;
let existing: { status: string; nextAttemptAt?: Date } | null = null;
let sendFailure = false;
let deleteFailure = false;
let visibilityFailure = false;
let preparationFailure = false;
let archiveFailure = false;
let archiveWrites = 0;
let persistFailure = false;
let publisherUpdates = 0;
let alreadyPublished = false;
let attemptCount = 1;
let limited = false;
let circuitOpen = false;
let partialBatch = false;

mock.module("@waybill/shared", () => ({
  ...shared,
  createSqsClient: () => ({ send: async (command: { constructor: { name: string }; input: { Entries?: { Id: string }[] } }) => {
    const name = command.constructor.name;
    if (name === "SendMessageCommand" && sendFailure) throw new Error("queue unavailable");
    if (name === "DeleteMessageCommand" && deleteFailure) throw new Error("delete unavailable");
    if (name.startsWith("ChangeMessageVisibility") && visibilityFailure) throw new Error("visibility unavailable");
    if (command.input.Entries) {
      const entries = command.input.Entries;
      return partialBatch ? { Successful: [entries[0]], Failed: [entries[1]] } : { Successful: entries };
    }
    return { MessageId: "test-confirmed" };
  } }),
  createS3Client: () => ({ send: async (command: { input: { Bucket?: string } }) => {
    archiveWrites++;
    expect(command.input.Bucket).toBe("waybill-metrics-test");
    if (archiveFailure) throw new Error("archive unavailable");
    return {};
  } }),
}));
mock.module("./delivery/circuit-breaker", () => ({
  ...circuit,
  createRedisClient: () => ({}),
  readCircuitState: async () => circuitOpen
    ? { state: "open", openedAt: Date.now(), failureCount: 5 }
    : { state: "closed", failureCount: 0 },
  recordDeliveryFailure: async () => ({ state: "closed", failureCount: 1 }),
  recordDeliverySuccess: async () => ({ state: "closed", failureCount: 0 }),
}));
mock.module("./delivery/rate-limiter", () => ({
  consumeTenantToken: async () => ({ allowed: !limited, retryAfterMs: 1000 }),
}));
mock.module("./repositories/tenants", () => ({
  findTenantSigningSecret: async () => {
    if (preparationFailure) throw new Error("tenant lookup unavailable");
    return "private-test-secret";
  },
}));
mock.module("./repositories/dead-letters", () => ({ createDeadLetter: async () => ({ id: "private-archive" }) }));
mock.module("./repositories/deliveries", () => ({
  findByEventAndUrl: async () => existing,
  upsertInFlight: async () => ({ id: "private-delivery", eventId: "private-event", tenantId: "private-tenant", attemptCount }),
  markSucceeded: async () => {
    if (persistFailure) throw new Error("database unavailable");
    existing = { status: "SUCCEEDED" };
  },
  markFailed: async () => {
    if (persistFailure) throw new Error("database unavailable");
  },
  markDeadLettered: async () => {
    if (persistFailure) throw new Error("database unavailable");
    existing = { status: "DEAD_LETTERED" };
  },
}));
mock.module("./repositories/outbox", () => ({
  listUnpublished: async () => [],
  markPublished: async () => {
    publisherUpdates++;
    if (persistFailure) throw new Error("database unavailable");
    return { count: alreadyPublished ? 0 : 1 };
  },
}));

const { handleMessage, deferExcessMessages } = await import("./index");
const { publishOne } = await import("./outbox-poller");
const metrics = shared.createWorkerMetrics(() => 0);
const receiver = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status }) });
const target = `http://127.0.0.1:${receiver.port}/webhook`;
const message: Message = { ReceiptHandle: "private-receipt", Body: JSON.stringify({
  eventId: "private-event", tenantId: "private-tenant", type: "test.event", payload: { value: 1 },
}) };
const queue = "https://sqs.example.invalid/private-queue";
process.env.SQS_QUEUE_URL = queue;
process.env.MAX_DELIVERY_ATTEMPTS = "8";

async function value(name: string, labels: Record<string, string> = {}, registry = metrics.registry) {
  const metric = (await registry.getMetricsAsJSON()).find(entry => entry.name === name);
  return metric?.values.filter(entry => Object.entries(labels).every(([key, value]) => entry.labels[key] === value))
    .reduce((total, entry) => total + entry.value, 0) ?? 0;
}
async function handle() { return handleMessage(queue, target, message, undefined, metrics); }
async function noAttempt() { expect(await value("waybill_webhook_attempts_total")).toBe(0); }

try {
  if (scenario.startsWith("publisher-")) {
    const publisher = shared.createPublisherMetrics();
    sendFailure = scenario === "publisher-send-failure";
    persistFailure = scenario === "publisher-persist-failure";
    alreadyPublished = scenario === "publisher-duplicate";
    const row: UnpublishedOutbox = { id: "private-outbox", eventId: "private-event", published: false,
      publishedAt: null, createdAt: new Date(), event: { id: "private-event", tenantId: "private-tenant",
        type: "test.event", payload: {}, payloadS3Key: null, createdAt: new Date() } };
    const result = publishOne(shared.prisma, row, undefined, publisher);
    if (sendFailure || persistFailure) await expect(result).rejects.toBeDefined();
    else await result;
    expect(publisherUpdates).toBe(sendFailure ? 0 : 1);
    const outcome = sendFailure ? "send_failed" : persistFailure ? "persist_failed" : alreadyPublished ? "already_published" : "published";
    expect(await value("waybill_outbox_publications_total", { outcome }, publisher.registry)).toBe(1);
    expect(await value("waybill_outbox_publications_total", {}, publisher.registry)).toBe(1);
    expect(await value("waybill_sqs_operations_total", { operation: "send", outcome: sendFailure ? "failure" : "success" }, publisher.registry)).toBe(1);
    expect(await publisher.registry.metrics()).not.toContain("private-");
  } else if (scenario === "success" || scenario === "delete-failure") {
    const acknowledge = await handle();
    expect(await value("waybill_webhook_attempts_total", { outcome: "success" })).toBe(1);
    expect(await value("waybill_delivery_terminal_outcomes_total", { outcome: "succeeded" })).toBe(1);
    expect(await value("waybill_sqs_operations_total", { operation: "delete" })).toBe(0);
    expect(typeof acknowledge).toBe("function");
    if (!acknowledge) throw new Error("Missing acknowledgement");
    deleteFailure = scenario === "delete-failure";
    if (deleteFailure) {
      await expect(acknowledge()).rejects.toBeDefined();
      expect(await value("waybill_sqs_operations_total", { operation: "delete", outcome: "failure" })).toBe(1);
    } else await acknowledge();
    deleteFailure = false;
    await handle();
    expect(await value("waybill_webhook_attempts_total")).toBe(1);
    expect(await value("waybill_delivery_terminal_outcomes_total")).toBe(1);
    expect(await value("waybill_sqs_operations_total", { operation: "delete", outcome: "success" })).toBe(scenario === "success" ? 2 : 1);
  } else if (["retry", "retry-visibility-failure", "preparation", "retry-persist-failure"].includes(scenario)) {
    status = 500;
    preparationFailure = scenario === "preparation";
    visibilityFailure = scenario === "retry-visibility-failure";
    persistFailure = scenario === "retry-persist-failure";
    if (visibilityFailure || persistFailure) await expect(handle()).rejects.toBeDefined();
    else await handle();
    expect(await value("waybill_webhook_attempts_total")).toBe(preparationFailure ? 0 : 1);
    expect(await value("waybill_delivery_retries_total", { reason: preparationFailure ? "preparation" : "webhook" })).toBe(persistFailure ? 0 : 1);
    expect(await value("waybill_delivery_terminal_outcomes_total")).toBe(0);
    expect(await value("waybill_delivery_deferrals_total")).toBe(0);
    expect(await value("waybill_sqs_operations_total", { operation: "change_visibility" })).toBe(persistFailure ? 0 : 1);
    if (visibilityFailure) expect(await value("waybill_sqs_operations_total", { outcome: "failure" })).toBe(1);
  } else if (["exhausted", "exhausted-preparation", "archive-failure", "terminal-persist-failure"].includes(scenario)) {
    status = scenario === "terminal-persist-failure" ? 204 : 500;
    attemptCount = 8;
    preparationFailure = scenario === "exhausted-preparation";
    archiveFailure = scenario === "archive-failure";
    persistFailure = scenario === "terminal-persist-failure";
    if (archiveFailure || persistFailure) await expect(handle()).rejects.toThrow(archiveFailure ? "archive unavailable" : "database unavailable");
    else await handle();
    expect(archiveWrites).toBe(persistFailure ? 0 : 1);
    expect(await value("waybill_webhook_attempts_total")).toBe(preparationFailure ? 0 : 1);
    expect(await value("waybill_delivery_terminal_outcomes_total")).toBe(archiveFailure || persistFailure ? 0 : 1);
    expect(await value("waybill_delivery_retries_total")).toBe(0);
    expect(await value("waybill_sqs_operations_total", { operation: "delete" })).toBe(archiveFailure || persistFailure ? 0 : 1);
  } else if (["circuit", "rate-limit", "not-due", "deferral-failure"].includes(scenario)) {
    circuitOpen = scenario === "circuit";
    limited = scenario === "rate-limit" || scenario === "deferral-failure";
    visibilityFailure = scenario === "deferral-failure";
    if (scenario === "not-due") existing = { status: "FAILED", nextAttemptAt: new Date(Date.now() + 60000) };
    if (visibilityFailure) await expect(handle()).rejects.toBeDefined();
    else await handle();
    await noAttempt();
    const reason = circuitOpen ? "circuit_open" : limited ? "rate_limit" : "not_due";
    expect(await value("waybill_delivery_deferrals_total", { reason })).toBe(visibilityFailure ? 0 : 1);
    expect(await value("waybill_sqs_operations_total", { operation: "change_visibility", outcome: visibilityFailure ? "failure" : "success" })).toBe(1);
  } else if (scenario === "batch-partial") {
    partialBatch = true;
    await deferExcessMessages(queue, [{ ReceiptHandle: "one" }, { ReceiptHandle: "two" }], metrics);
    expect(await value("waybill_delivery_deferrals_total", { reason: "tenant_turn" })).toBe(1);
    expect(await value("waybill_sqs_operations_total", { operation: "change_visibility", outcome: "failure" })).toBe(1);
    await noAttempt();
  } else if (scenario === "poison") {
    await handleMessage(queue, target, { ...message, Body: "invalid" }, undefined, metrics);
    await noAttempt();
    expect(await value("waybill_delivery_terminal_outcomes_total")).toBe(0);
    expect(await value("waybill_sqs_operations_total", { operation: "delete", outcome: "success" })).toBe(1);
  } else throw new Error("Unknown metrics scenario");
  expect(await metrics.registry.metrics()).not.toContain("private-");
  console.log(`PASS ${scenario}`);
} finally {
  await receiver.stop(true);
}
