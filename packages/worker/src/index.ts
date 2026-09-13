import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  createS3Client,
  createSqsClient,
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
import { postWebhook } from "./delivery/http";
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
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
): Promise<void> {
  const sqs = createSqsClient();
  await sendWithTimeout(
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
  );
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

  const sqs = createSqsClient();
  await sendWithTimeout(
    (abortSignal) =>
      sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receipt,
        }),
        { abortSignal },
      ),
    "SQS DeleteMessage",
  );
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
): Promise<Date> {
  const when = nextAttemptAt(attemptCount);
  const delayMs = Math.max(when.getTime() - Date.now(), 1000);
  await markFailed(deliveryId, error, when);
  await hideUntil(queueUrl, receipt, delayMs);
  return when;
}

async function handleMessage(
  queueUrl: string,
  targetUrl: string,
  sqsMessage: Message,
  redis = createRedisClient(),
): Promise<void> {
  const sqs = createSqsClient();
  const receipt = sqsMessage.ReceiptHandle;
  if (!receipt) {
    throw new Error("SQS message missing ReceiptHandle");
  }

  const breaker = await readCircuitState(redis, targetUrl);
  const decision = getCircuitDecision(breaker, Date.now());
  if (!decision.allowed) {
    const delayMs = Math.max(decision.delayMs, 1000);
    await hideUntil(queueUrl, receipt, delayMs);
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
    await sendWithTimeout(
      (abortSignal) =>
        sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: receipt,
          }),
          { abortSignal },
        ),
      "SQS DeleteMessage",
    );
    return;
  }

  const existing = await findByEventAndUrl(parsed.eventId, targetUrl);
  if (existing?.status === "DEAD_LETTERED") {
    await sendWithTimeout(
      (abortSignal) =>
        sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: receipt,
          }),
          { abortSignal },
        ),
      "SQS DeleteMessage",
    );
    console.log("delivery already dead-lettered, deleted SQS message", {
      eventId: parsed.eventId,
    });
    return;
  }
  if (existing?.nextAttemptAt && existing.nextAttemptAt.getTime() > Date.now()) {
    const delayMs = existing.nextAttemptAt.getTime() - Date.now();
    await hideUntil(queueUrl, receipt, delayMs);
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
  try {
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
      );
      return;
    }
    const when = await scheduleRetry(
      delivery.id,
      delivery.attemptCount,
      error,
      queueUrl,
      receipt,
    );
    console.error("payload load failed, scheduled retry", {
      eventId: parsed.eventId,
      error,
      nextAttemptAt: when.toISOString(),
    });
    return;
  }

  const result = await postWebhook(targetUrl, {
    eventId: parsed.eventId,
    tenantId: parsed.tenantId,
    type: parsed.type,
    payload,
  });

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
      );
      return;
    }
    const when = await scheduleRetry(
      delivery.id,
      delivery.attemptCount,
      result.error,
      queueUrl,
      receipt,
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
  await sendWithTimeout(
    (abortSignal) =>
      sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receipt,
        }),
        { abortSignal },
      ),
    "SQS DeleteMessage",
  );
  console.log("delivery succeeded", {
    eventId: parsed.eventId,
    deliveryId: delivery.id,
    circuitState: afterSuccess.state,
  });
}

async function main(): Promise<void> {
  const queueUrl = requireEnv("SQS_QUEUE_URL");
  const targetUrl = requireEnv("RECEIVER_URL");
  const sqs = createSqsClient();
  const redis = createRedisClient();
  await redis.connect();

  console.log("delivery worker started");

  while (true) {
    try {
      const received = await sendWithTimeout(
        (abortSignal) =>
          sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: queueUrl,
              MaxNumberOfMessages: 5,
              WaitTimeSeconds: LONG_POLL_SECONDS,
              VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
              MessageAttributeNames: ["All"],
            }),
            { abortSignal },
          ),
        "SQS ReceiveMessage",
      );

      const messages = received.Messages ?? [];
      for (const message of messages) {
        try {
          await handleMessage(queueUrl, targetUrl, message, redis);
        } catch (err) {
          console.error("handle message failed", {
            messageId: message.MessageId,
            err,
          });
        }
      }
    } catch (err) {
      console.error("receive loop failed", err);
    }
  }
}

main().catch((err: unknown) => {
  console.error("delivery worker crashed", err);
  process.exit(1);
});
