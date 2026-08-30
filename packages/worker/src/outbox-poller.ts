import { SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  createSqsClient,
  type QueueMessage,
} from "@waybill/shared";
import { listUnpublished, markPublished } from "./repositories/outbox";

const POLL_MS = 2000;
const BATCH_SIZE = 10;
const SQS_TIMEOUT_MS = 8000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithTimeout<T>(
  send: (abortSignal: AbortSignal) => Promise<T>,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SQS_TIMEOUT_MS);
  try {
    return await send(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${SQS_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function publishOne(
  row: Awaited<ReturnType<typeof listUnpublished>>[number],
): Promise<void> {
  const queueUrl = requireEnv("SQS_QUEUE_URL");
  const sqs = createSqsClient();

  const message: QueueMessage = {
    eventId: row.event.id,
    tenantId: row.event.tenantId,
    type: row.event.type,
    payload: row.event.payloadS3Key ? null : row.event.payload,
    payloadS3Key: row.event.payloadS3Key,
  };

  await sendWithTimeout(
    (abortSignal) =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message),
          MessageAttributes: {
            tenantId: {
              DataType: "String",
              StringValue: row.event.tenantId,
            },
          },
        }),
        { abortSignal },
      ),
    "SQS SendMessage",
  );

  const updated = await markPublished(row.id);
  if (updated.count === 0) {
    console.warn("outbox already published, possible duplicate SQS message", {
      outboxId: row.id,
      eventId: row.eventId,
    });
    return;
  }

  console.log("outbox published", {
    outboxId: row.id,
    eventId: row.eventId,
    storedIn: message.payloadS3Key ? "s3" : "postgres",
  });
}

async function tick(): Promise<void> {
  const rows = await listUnpublished(BATCH_SIZE);
  for (const row of rows) {
    try {
      await publishOne(row);
    } catch (err) {
      console.error("outbox publish failed", {
        outboxId: row.id,
        eventId: row.eventId,
        err,
      });
    }
  }
}

async function main(): Promise<void> {
  requireEnv("SQS_QUEUE_URL");
  requireEnv("AWS_REGION");
  console.log("outbox poller started");

  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error("outbox poll tick failed", err);
    }
    await sleep(POLL_MS);
  }
}

main().catch((err: unknown) => {
  console.error("outbox poller crashed", err);
  process.exit(1);
});
