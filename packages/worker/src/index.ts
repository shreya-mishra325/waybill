import {
  ChangeMessageVisibilityCommand,
  ChangeMessageVisibilityBatchCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  createS3Client,
  createSqsClient,
  createWorkerMetrics,
  metricsServerOptions,
  startMetricsServer,
  observeSqsOperation,
  type WorkerMetrics,
  type QueueMessage,
} from "@waybill/shared";
import {
  isExhausted,
  nextAttemptAt,
  visibilityTimeoutSeconds,
} from "./delivery/backoff";
import {
  circuitKeyForTarget,
  createRedisClient,
  getCircuitDecision,
  readCircuitState,
  recordDeliveryFailure,
  recordDeliverySuccess,
} from "./delivery/circuit-breaker";
import { TenantTurns } from "./delivery/tenant-turns";
import { VisibilityLeases } from "./delivery/visibility";
import { confirmedBatchReceipts } from "./delivery/queue-confirmations";
import { postWebhook } from "./delivery/http";
import { processDeliveryBatch, type Acknowledge } from "./delivery/message-batch";
import { consumeTenantToken } from "./delivery/rate-limiter";
import { findTenantSigningSecret } from "./repositories/tenants";
import { createDeadLetter } from "./repositories/dead-letters";
import {
  findByEventAndUrl,
  markDeadLettered,
  markFailed,
  markSucceeded,
  upsertInFlight,
} from "./repositories/deliveries";

const LONG_POLL_SECONDS = 20;
const VISIBILITY_TIMEOUT_SECONDS = 30;
const AWS_TIMEOUT_MS = 25_000;
const RECEIVE_BATCHES = 10;
let visibility: VisibilityLeases | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function workerRateLimitConfig(): {
  capacity: number;
  refillPerSecond: number;
} {
  return {
    capacity: Number(process.env.DELIVERY_RATE_LIMIT_CAPACITY ?? 10),
    refillPerSecond: Number(
      process.env.DELIVERY_RATE_LIMIT_REFILL_PER_SECOND ?? 10,
    ),
  };
}

async function sendWithTimeout<T>(
  send: (abortSignal: AbortSignal) => Promise<T>,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AWS_TIMEOUT_MS);
  try {
    return await send(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${AWS_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseQueueMessage(body: string): QueueMessage | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.eventId !== "string" ||
      typeof value.tenantId !== "string" ||
      typeof value.type !== "string"
    ) {
      return null;
    }
    return {
      eventId: value.eventId,
      tenantId: value.tenantId,
      type: value.type,
      payload: value.payload ?? null,
      payloadS3Key:
        typeof value.payloadS3Key === "string" ? value.payloadS3Key : null,
    };
  } catch {
    return null;
  }
}

async function loadPayload(
  message: QueueMessage,
): Promise<unknown> {
  if (!message.payloadS3Key) {
    return message.payload;
  }

  const s3 = createS3Client();
  const result = await sendWithTimeout(
    (abortSignal) =>
      s3.send(
        new GetObjectCommand({
          Bucket: requireEnv("S3_BUCKET_NAME"),
          Key: message.payloadS3Key ?? undefined,
        }),
        { abortSignal },
      ),
    "S3 GetObject",
  );

  const text = await result.Body?.transformToString();
  if (text === undefined) {
    throw new Error(`S3 object empty: ${message.payloadS3Key}`);
  }
  return JSON.parse(text);
}

async function hideUntil(
  queueUrl: string,
  receipt: string,
  delayMs: number,
  metrics?: WorkerMetrics,
  reason?: "circuit_open" | "rate_limit" | "not_due",
): Promise<void> {
  await visibility?.release(receipt);
  const sqs = createSqsClient();
  await observeSqsOperation(metrics, "change_visibility", () => sendWithTimeout(
    (abortSignal) =>
      sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receipt,
          VisibilityTimeout: visibilityTimeoutSeconds(delayMs),
        }),
        { abortSignal },
      ),
    "SQS ChangeMessageVisibility",
  ));
  if (reason) metrics?.recordDeferral(reason);
}

export async function deferExcessMessages(queueUrl: string, messages: Message[], metrics?: WorkerMetrics): Promise<void> {
  const receipts = messages.flatMap((message) => message.ReceiptHandle ? [message.ReceiptHandle] : []);
  await Promise.all(receipts.map((receipt) => visibility?.release(receipt)));
  const batches: string[][] = [];
  for (let i = 0; i < receipts.length; i += 10) batches.push(receipts.slice(i, i + 10));
  const results = await Promise.allSettled(batches.map(async (batch) => {
    const result = await observeSqsOperation(metrics, "change_visibility", () => createSqsClient().send(new ChangeMessageVisibilityBatchCommand({
      QueueUrl: queueUrl,
      Entries: batch.map((receipt, index) => ({
        Id: String(index), ReceiptHandle: receipt, VisibilityTimeout: 30,
      })),
    }), { abortSignal: AbortSignal.timeout(8000) }), result => !result.Failed?.length && confirmedBatchReceipts(batch, result).size === batch.length);
    const confirmed = confirmedBatchReceipts(batch, result);
    if (confirmed.size) metrics?.recordDeferral("tenant_turn", confirmed.size);
    if (result.Failed?.length || confirmed.size !== batch.length) {
      throw new Error(`Incomplete tenant-turn deferral: ${JSON.stringify(result.Failed ?? [])}`);
    }
  }));
  for (const result of results) {
    if (result.status === "rejected") console.error("tenant-turn deferral failed", result.reason);
  }
}

async function acknowledgeMessage(queueUrl: string, receipt: string, metrics?: WorkerMetrics): Promise<void> {
  await visibility?.release(receipt);
  await observeSqsOperation(metrics, "delete", () => sendWithTimeout(
    (abortSignal) => createSqsClient().send(new DeleteMessageCommand({
      QueueUrl: queueUrl, ReceiptHandle: receipt,
    }), { abortSignal }),
    "SQS DeleteMessage",
  ));
}

async function archivePayload(message: QueueMessage): Promise<string> {
  if (message.payloadS3Key) {
    return message.payloadS3Key;
  }

  const key = `dead-letters/${message.eventId}.json`;
  const s3 = createS3Client();
  await sendWithTimeout(
    (abortSignal) =>
      s3.send(
        new PutObjectCommand({
          Bucket: requireEnv("S3_BUCKET_NAME"),
          Key: key,
          Body: JSON.stringify(message.payload),
          ContentType: "application/json",
        }),
        { abortSignal },
      ),
    "S3 PutObject",
  );
  return key;
}

async function moveToDeadLetter(
  delivery: { id: string; eventId: string; tenantId: string; attemptCount: number },
  targetUrl: string,
  error: string,
  message: QueueMessage,
  queueUrl: string,
  receipt: string,
  metrics?: WorkerMetrics,
): Promise<void> {
  const payloadS3Key = await archivePayload(message);
  await createDeadLetter({
    eventId: delivery.eventId,
    deliveryId: delivery.id,
    tenantId: delivery.tenantId,
    targetUrl,
    lastError: error.slice(0, 500),
    attemptCount: delivery.attemptCount,
    payloadS3Key,
  });
  await markDeadLettered(delivery.id, error);
  metrics?.recordTerminal("dead_lettered");

  await acknowledgeMessage(queueUrl, receipt, metrics);
  console.log("delivery dead-lettered", {
    eventId: delivery.eventId,
    deliveryId: delivery.id,
    attemptCount: delivery.attemptCount,
    payloadS3Key,
  });
}

async function scheduleRetry(
  deliveryId: string,
  attemptCount: number,
  error: string,
  queueUrl: string,
  receipt: string,
  reason: "preparation" | "webhook",
  metrics?: WorkerMetrics,
): Promise<Date> {
  const when = nextAttemptAt(attemptCount);
  const delayMs = Math.max(when.getTime() - Date.now(), 1000);
  await markFailed(deliveryId, error, when);
  metrics?.recordRetry(reason);
  await hideUntil(queueUrl, receipt, delayMs, metrics);
  return when;
}

export async function handleMessage(
  queueUrl: string,
  targetUrl: string,
  sqsMessage: Message,
  redis = createRedisClient(),
  metrics?: WorkerMetrics,
): Promise<Acknowledge | void> {
  const receipt = sqsMessage.ReceiptHandle;
  if (!receipt) {
    throw new Error("SQS message missing ReceiptHandle");
  }

  const breaker = await readCircuitState(redis, targetUrl);
  const decision = getCircuitDecision(breaker, Date.now());
  if (!decision.allowed) {
    const delayMs = Math.max(decision.delayMs, 1000);
    await hideUntil(queueUrl, receipt, delayMs, metrics, "circuit_open");
    console.log("destination circuit open, message hidden until cooldown expires", {
      messageId: sqsMessage.MessageId,
      targetUrl,
      state: decision.state,
      delayMs,
    });
    return;
  }

  const parsed = parseQueueMessage(sqsMessage.Body ?? "");
  if (!parsed) {
    console.error("poison SQS message, deleting", {
      messageId: sqsMessage.MessageId,
    });
    await acknowledgeMessage(queueUrl, receipt, metrics);
    return;
  }

  const rateLimit = await consumeTenantToken(
    redis,
    parsed.tenantId,
    "delivery",
    workerRateLimitConfig(),
  );
  if (!rateLimit.allowed) {
    const delayMs = Math.max(rateLimit.retryAfterMs, 1000);
    await hideUntil(queueUrl, receipt, delayMs, metrics, "rate_limit");
    console.log("tenant rate limit exceeded, message hidden", {
      eventId: parsed.eventId,
      tenantId: parsed.tenantId,
      delayMs,
    });
    return;
  }

  const existing = await findByEventAndUrl(parsed.eventId, targetUrl);
  if (existing?.status === "DEAD_LETTERED" || existing?.status === "SUCCEEDED") {
    await acknowledgeMessage(queueUrl, receipt, metrics);
    console.log("delivery already complete, deleted SQS message", {
      eventId: parsed.eventId,
      status: existing.status,
    });
    return;
  }
  if (existing?.nextAttemptAt && existing.nextAttemptAt.getTime() > Date.now()) {
    const delayMs = existing.nextAttemptAt.getTime() - Date.now();
    await hideUntil(queueUrl, receipt, delayMs, metrics, "not_due");
    console.log("delivery not due yet, hid SQS message", {
      eventId: parsed.eventId,
      nextAttemptAt: existing.nextAttemptAt.toISOString(),
    });
    return;
  }

  if (decision.state === "half-open") {
    await redis.hset(circuitKeyForTarget(targetUrl), {
      halfOpenInFlight: "true",
    });
  }

  const delivery = await upsertInFlight({
    eventId: parsed.eventId,
    tenantId: parsed.tenantId,
    targetUrl,
  });

  let payload: unknown;
  let signingSecret: string;
  try {
    signingSecret = await findTenantSigningSecret(parsed.tenantId);
    payload = await loadPayload(parsed);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (isExhausted(delivery.attemptCount)) {
      await moveToDeadLetter(
        delivery,
        targetUrl,
        error,
        parsed,
        queueUrl,
        receipt,
        metrics,
      );
      return;
    }
    const when = await scheduleRetry(
      delivery.id,
      delivery.attemptCount,
      error,
      queueUrl,
      receipt,
      "preparation",
      metrics,
    );
    console.error("webhook preparation failed, scheduled retry", {
      eventId: parsed.eventId,
      error,
      nextAttemptAt: when.toISOString(),
    });
    return;
  }

  const started = metrics ? performance.now() : 0;
  const result = await postWebhook(targetUrl, {
    eventId: parsed.eventId,
    tenantId: parsed.tenantId,
    type: parsed.type,
    payload,
  }, signingSecret);
  metrics?.recordWebhook(result.ok ? "success" : "failure", (performance.now() - started) / 1000);

  if (!result.ok) {
    const afterFailure = await recordDeliveryFailure(redis, targetUrl);
    if (afterFailure.state === "open") {
      console.warn("destination circuit opened", {
        targetUrl,
        failureCount: afterFailure.failureCount,
      });
    }
    if (isExhausted(delivery.attemptCount)) {
      await moveToDeadLetter(
        delivery,
        targetUrl,
        result.error,
        parsed,
        queueUrl,
        receipt,
        metrics,
      );
      return;
    }
    const when = await scheduleRetry(
      delivery.id,
      delivery.attemptCount,
      result.error,
      queueUrl,
      receipt,
      "webhook",
      metrics,
    );
    console.error("delivery failed, scheduled retry", {
      eventId: parsed.eventId,
      attemptCount: delivery.attemptCount,
      error: result.error,
      nextAttemptAt: when.toISOString(),
      circuitState: afterFailure.state,
    });
    return;
  }

  const afterSuccess = await recordDeliverySuccess(redis, targetUrl);
  await markSucceeded(delivery.id);
  metrics?.recordTerminal("succeeded");
  return async () => {
    await acknowledgeMessage(queueUrl, receipt, metrics);
    console.log("delivery succeeded", {
      eventId: parsed.eventId,
      deliveryId: delivery.id,
      circuitState: afterSuccess.state,
    });
  };
}

async function main(): Promise<void> {
  const queueUrl = requireEnv("SQS_QUEUE_URL");
  const targetUrl = requireEnv("RECEIVER_URL");
  const metricsOptions = metricsServerOptions(process.env, 9102, "WORKER_METRICS_PORT");
  const metrics = metricsOptions ? createWorkerMetrics(() => visibility?.ownedSize ?? 0) : undefined;
  let metricsServer: ReturnType<typeof startMetricsServer> | undefined;
  if (metrics && metricsOptions) {
    try {
      metricsServer = startMetricsServer(metrics.registry, metricsOptions);
    } catch (error) {
      console.error("Worker metrics listener failed to start; worker will continue", error);
    }
  }
  const sqs = createSqsClient();
  const redis = createRedisClient();
  await redis.connect();

  visibility = new VisibilityLeases(async (receipts) => {
    const result = await observeSqsOperation(metrics, "change_visibility", () => sqs.send(new ChangeMessageVisibilityBatchCommand({
      QueueUrl: queueUrl,
      Entries: receipts.map((receipt, index) => ({
        Id: String(index), ReceiptHandle: receipt, VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
      })),
    }), { abortSignal: AbortSignal.timeout(8000) }), result => !result.Failed?.length && confirmedBatchReceipts(receipts, result).size === receipts.length);
    if (result.Failed?.length) console.error("visibility renewal entries failed", result.Failed);
    return confirmedBatchReceipts(receipts, result);
  }, (err) => console.error("visibility renewal failed", err));
  const leases = visibility;
  console.log("delivery worker started", { maxBufferedMessages: RECEIVE_BATCHES * 10 });

  try {
    while (true) {
      type ReceiveResult = { id: number; messages: Message[]; error?: unknown };
      const pendingReceives = new Map<number, Promise<ReceiveResult>>();
      let receiveFailed = false;
      const turns = new TenantTurns();
      const deferred: Message[] = [];
      for (let id = 0; id < RECEIVE_BATCHES; id++) {
        const pending = observeSqsOperation(metrics, "receive", () => sendWithTimeout(
          (abortSignal) => sqs.send(new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: LONG_POLL_SECONDS,
            VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
            MessageAttributeNames: ["All"],
            MessageSystemAttributeNames: ["MessageGroupId"],
          }), { abortSignal }),
          "SQS ReceiveMessage",
        )).then((response) => {
          const messages = response.Messages ?? [];
          for (const message of messages) {
            if (message.ReceiptHandle) leases.track(message.ReceiptHandle);
          }
          console.log("SQS receive buffer", {
            received: messages.length,
            buffered: leases.size,
            groups: [...new Set(messages.map((message) => message.Attributes?.MessageGroupId ?? "unassigned"))],
          });
          return { id, messages };
        }).catch((error: unknown) => ({ id, messages: [], error }));
        pendingReceives.set(id, pending);
      }
      while (pendingReceives.size) {
        const result = await Promise.race(pendingReceives.values());
        pendingReceives.delete(result.id);
        if (result.error !== undefined) {
          receiveFailed = true;
          console.error("receive failed", result.error);
        }
        const messages = result.messages;
        await processDeliveryBatch(messages, async (message) => {
          const receipt = message.ReceiptHandle;
          if (receipt && !leases.isCurrent(receipt)) {
            await leases.release(receipt);
            console.warn("skipping message after visibility ownership became uncertain", { messageId: message.MessageId });
            return;
          }
          const parsed = parseQueueMessage(message.Body ?? "");
          if (parsed && !turns.take(parsed.tenantId)) {
            deferred.push(message);
            return;
          }
          try {
            const acknowledge = await handleMessage(queueUrl, targetUrl, message, redis, metrics);
            if (!acknowledge && receipt) await leases.release(receipt);
            return acknowledge;
          } catch (err) {
            if (receipt) await leases.release(receipt);
            throw err;
          }
        }, (message, err) => console.error("handle message failed", { messageId: message.MessageId, err }));
      }
      await deferExcessMessages(queueUrl, deferred, metrics);
      if (receiveFailed) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } finally {
    try {
      await leases.stop();
      await redis.quit();
    } finally {
      await metricsServer?.stop(true);
    }
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("delivery worker crashed", err);
    process.exit(1);
  });
}
