import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  createS3Client,
  createSqsClient,
  type QueueMessage,
} from "@waybill/shared";
import { postWebhook } from "./delivery/http";
import {
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

async function handleMessage(
  queueUrl: string,
  targetUrl: string,
  sqsMessage: Message,
): Promise<void> {
  const sqs = createSqsClient();
  const receipt = sqsMessage.ReceiptHandle;
  if (!receipt) {
    throw new Error("SQS message missing ReceiptHandle");
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
    await markFailed(delivery.id, error);
    console.error("payload load failed, leaving SQS message", {
      eventId: parsed.eventId,
      error,
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
    await markFailed(delivery.id, result.error);
    console.error("delivery failed, leaving SQS message", {
      eventId: parsed.eventId,
      error: result.error,
    });
    return;
  }

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
  });
}

async function main(): Promise<void> {
  const queueUrl = requireEnv("SQS_QUEUE_URL");
  const targetUrl = requireEnv("RECEIVER_URL");
  const sqs = createSqsClient();

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
          await handleMessage(queueUrl, targetUrl, message);
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
