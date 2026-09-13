import Redis from "ioredis";
import {
  consumeTenantToken,
  type TokenBucketDecision,
} from "@waybill/shared";

let client: Redis | undefined;

function requireRedisUrl(): string {
  const value = process.env.REDIS_URL;
  if (!value) {
    throw new Error("Missing required env var: REDIS_URL");
  }
  return value;
}

function rateLimitConfig(): { capacity: number; refillPerSecond: number } {
  return {
    capacity: Number(process.env.INGESTION_RATE_LIMIT_CAPACITY ?? 10),
    refillPerSecond: Number(
      process.env.INGESTION_RATE_LIMIT_REFILL_PER_SECOND ?? 10,
    ),
  };
}

function redisClient(): Redis {
  client ??= new Redis(requireRedisUrl(), {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 3,
  });
  return client;
}

async function readyRedisClient(): Promise<Redis> {
  const current = redisClient();
  if (current.status === "wait") {
    await current.connect();
    return current;
  }
  if (current.status !== "ready") {
    await new Promise<void>((resolve, reject) => {
      current.once("ready", resolve);
      current.once("error", reject);
    });
  }
  return current;
}

export class IngestionRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("tenant ingestion rate limit exceeded");
    this.name = "IngestionRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export async function enforceIngestionRateLimit(
  tenantId: string,
): Promise<TokenBucketDecision> {
  const decision = await consumeTenantToken(
    await readyRedisClient(),
    tenantId,
    rateLimitConfig(),
  );
  if (!decision.allowed) {
    throw new IngestionRateLimitError(decision.retryAfterMs);
  }
  return decision;
}