import { PutObjectCommand } from "@aws-sdk/client-s3";
import { Prisma, createS3Client, prisma } from "@waybill/shared";
import { z } from "zod";
import {
  createEvent,
  createOutbox,
  findTenantById,
} from "../repositories/events";

const DEFAULT_SQS_MAX_MESSAGE_BYTES = 262144;
const S3_TIMEOUT_MS = 15_000;

const ingestSchema = z.object({
  tenantId: z.string().uuid(),
  type: z.string().min(1).max(200),
  payload: z.unknown(),
});

export class TenantNotFoundError extends Error {
  readonly tenantId: string;

  constructor(tenantId: string) {
    super(`Tenant not found: ${tenantId}`);
    this.name = "TenantNotFoundError";
    this.tenantId = tenantId;
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export type IngestedEvent = {
  eventId: string;
  outboxId: string;
  storedIn: "postgres" | "s3";
};

function payloadBytes(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

function sqsMaxBytes(): number {
  const raw = process.env.SQS_MAX_MESSAGE_BYTES;
  if (!raw) {
    return DEFAULT_SQS_MAX_MESSAGE_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("SQS_MAX_MESSAGE_BYTES must be a positive number");
  }
  return parsed;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function uploadPayloadToS3(key: string, body: string): Promise<void> {
  const s3 = createS3Client();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), S3_TIMEOUT_MS);
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: requireEnv("S3_BUCKET_NAME"),
        Key: key,
        Body: body,
        ContentType: "application/json",
      }),
      { abortSignal: controller.signal },
    );
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`S3 PutObject timed out after ${S3_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function ingestEvent(input: unknown): Promise<IngestedEvent> {
  const parsed = ingestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  }

  const { tenantId, type, payload } = parsed.data;
  if (payload === undefined) {
    throw new ValidationError("payload is required");
  }

  const tenant = await findTenantById(tenantId);
  if (!tenant) {
    throw new TenantNotFoundError(tenantId);
  }

  const eventId = crypto.randomUUID();
  const json = JSON.stringify(payload);
  const tooLargeForSqs = payloadBytes(payload) > sqsMaxBytes();

  let inlinePayload: Prisma.InputJsonValue | null = JSON.parse(
    json,
  ) as Prisma.InputJsonValue;
  let payloadS3Key: string | null = null;
  let storedIn: IngestedEvent["storedIn"] = "postgres";

  if (tooLargeForSqs) {
    payloadS3Key = `events/${tenantId}/${eventId}.json`;
    await uploadPayloadToS3(payloadS3Key, json);
    inlinePayload = null;
    storedIn = "s3";
  }

  const { event, outbox } = await prisma.$transaction(async (tx) => {
    const event = await createEvent(tx, {
      id: eventId,
      tenantId,
      type,
      payload: inlinePayload,
      payloadS3Key,
    });
    const outbox = await createOutbox(tx, event.id);
    return { event, outbox };
  });

  return { eventId: event.id, outboxId: outbox.id, storedIn };
}
