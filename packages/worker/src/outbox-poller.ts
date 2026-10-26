import { SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  createSingleConnectionPrisma,
  createSqsClient,
  createPublisherMetrics,
  createBacklogMetrics,
  metricsServerOptions,
  startMetricsServer,
  observeSqsOperation,
  type PublisherMetrics,
  type Prisma,
  type PrismaClient,
  type QueueMessage,
} from "@waybill/shared";
import { listUnpublished, markPublished } from "./repositories/outbox";
import { createOutboxBacklogReader } from "./repositories/outbox-backlog";
import { readQueueBacklog } from "./repositories/queue-backlog";
import { startBacklogSampler } from "./metrics/backlog-sampler";

const POLL_MS = 2000;
const STANDBY_MS = 2000;
const BATCH_SIZE = 10;
const SQS_TIMEOUT_MS = 8000;
const OUTBOX_LOCK_KEY = 728401;

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

async function tryBecomeLeader(db: PrismaClient): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(${OUTBOX_LOCK_KEY}) AS locked
  `;
  return rows[0]?.locked === true;
}

async function releaseLeader(db: PrismaClient): Promise<void> {
  await db.$queryRaw`
    SELECT pg_advisory_unlock(${OUTBOX_LOCK_KEY})
  `;
}

export async function publishOne(
  db: Prisma.TransactionClient,
  row: Awaited<ReturnType<typeof listUnpublished>>[number],
  sqs = createSqsClient(),
  metrics?: PublisherMetrics,
): Promise<void> {
  const queueUrl = requireEnv("SQS_QUEUE_URL");

  const message: QueueMessage = {
    eventId: row.event.id,
    tenantId: row.event.tenantId,
    type: row.event.type,
    payload: row.event.payloadS3Key ? null : row.event.payload,
    payloadS3Key: row.event.payloadS3Key,
  };

  try {
    await observeSqsOperation(metrics, "send", () => sendWithTimeout(
      (abortSignal) =>
        sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageGroupId: row.event.tenantId,
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
    ));
  } catch (error) {
    metrics?.recordPublication("send_failed");
    throw error;
  }

  let updated: { count: number };
  try {
    updated = await markPublished(db, row.id);
  } catch (error) {
    metrics?.recordPublication("persist_failed");
    throw error;
  }
  if (updated.count === 0) {
    metrics?.recordPublication("already_published");
    console.warn("outbox already published, possible duplicate SQS message", {
      outboxId: row.id,
      eventId: row.eventId,
    });
    return;
  }

  metrics?.recordPublication("published");
  console.log("outbox published", {
    outboxId: row.id,
    eventId: row.eventId,
    storedIn: message.payloadS3Key ? "s3" : "postgres",
  });
}

export async function tick(db: PrismaClient, afterTenantId = "", metrics?: PublisherMetrics) {
  const rows = await listUnpublished(db, BATCH_SIZE, afterTenantId);
  const results = await Promise.allSettled(rows.map((row) => publishOne(db, row, undefined, metrics)));
  let failed = false;
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failed = true;
      const row = rows[index];
      console.error("outbox publish failed", {
        outboxId: row.id,
        eventId: row.eventId,
        err: result.reason,
      });
    }
  });
  return {
    count: rows.length,
    failed,
    afterTenantId: rows.at(-1)?.event.tenantId ?? afterTenantId,
  };
}

async function main(): Promise<void> {
  requireEnv("SQS_QUEUE_URL");
  requireEnv("AWS_REGION");

  const metricsOptions = metricsServerOptions(process.env, 9101, "PUBLISHER_METRICS_PORT");
  const metrics = metricsOptions ? createPublisherMetrics() : undefined;
  let metricsServer: ReturnType<typeof startMetricsServer> | undefined;
  if (metrics && metricsOptions) {
    try {
      metricsServer = startMetricsServer(metrics.registry, metricsOptions);
    } catch (error) {
      console.error("Publisher metrics listener failed to start; publisher will continue", error);
    }
  }
  const backlogReader = metrics ? createOutboxBacklogReader(process.env.DATABASE_URL) : undefined;
  const backlogSampler = metrics && backlogReader ? startBacklogSampler({
    metrics: createBacklogMetrics(metrics.registry),
    readOutbox: signal => backlogReader.count(signal),
    readQueue: signal => readQueueBacklog(createSqsClient(), requireEnv("SQS_QUEUE_URL"), signal),
    onError: (source, error) => console.error("Backlog sample failed", { source, error }),
  }) : undefined;
  const db = createSingleConnectionPrisma();
  let isLeader = false;
  let stopping = false;
  let afterTenantId = "";

  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  console.log("outbox poller started");

  try {
    while (!stopping) {
      try {
        if (!isLeader) {
          isLeader = await tryBecomeLeader(db);
          if (!isLeader) {
            console.log("standby, another poller holds the lock");
            await sleep(STANDBY_MS);
            continue;
          }
          console.log("became leader");
        }

        const result = await tick(db, afterTenantId, metrics);
        afterTenantId = result.afterTenantId;
        if (result.failed) throw new Error("One or more outbox publications failed");
        if (result.count === 0 && !stopping) await sleep(POLL_MS);
      } catch (err) {
        console.error("outbox poll tick failed", err);
        isLeader = false;
        await db.$disconnect();
        if (!stopping) await sleep(POLL_MS);
      }
    }
  } finally {
    try {
      await backlogSampler?.stop();
    } finally {
      try {
        await backlogReader?.disconnect();
      } finally {
        try {
          if (isLeader) await releaseLeader(db);
        } finally {
          try {
            await db.$disconnect();
          } finally {
            await metricsServer?.stop(true);
          }
        }
      }
    }
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error("outbox poller crashed", err);
    process.exit(1);
  });
}
