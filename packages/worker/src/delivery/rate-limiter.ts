import Redis from "ioredis";

export type RateLimitConfig = {
  capacity: number;
  refillPerSecond: number;
};

export type TokenBucketSnapshot = {
  tokens: number;
  lastRefillAt: number;
};

export type TokenBucketDecision = {
  allowed: boolean;
  tokens: number;
  retryAfterMs: number;
};

const DEFAULT_CONFIG: RateLimitConfig = {
  capacity: 10,
  refillPerSecond: 10,
};

const CONSUME_TOKEN_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refill_per_second = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
local last_refill_at = tonumber(redis.call('HGET', KEYS[1], 'lastRefillAt'))

if not tokens then tokens = capacity end
if not last_refill_at then last_refill_at = now end

local elapsed = math.max(0, now - last_refill_at)
tokens = math.min(capacity, tokens + elapsed * refill_per_second / 1000)
local allowed = 0
local retry_after_ms = 0

if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after_ms = math.ceil((1 - tokens) * 1000 / refill_per_second)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'lastRefillAt', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(1000 * capacity / refill_per_second))
return { allowed, tokens, retry_after_ms }
`;

export function normalizeRateLimitConfig(
  overrides?: Partial<RateLimitConfig>,
): RateLimitConfig {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  if (config.capacity <= 0 || config.refillPerSecond <= 0) {
    throw new Error("rate limit capacity and refill rate must be positive");
  }
  return config;
}

export function consumeToken(
  current: TokenBucketSnapshot,
  now: number,
  overrides?: Partial<RateLimitConfig>,
): TokenBucketDecision & { snapshot: TokenBucketSnapshot } {
  const config = normalizeRateLimitConfig(overrides);
  const elapsedMs = Math.max(0, now - current.lastRefillAt);
  const refilled = Math.min(
    config.capacity,
    current.tokens + (elapsedMs * config.refillPerSecond) / 1000,
  );

  if (refilled < 1) {
    return {
      allowed: false,
      tokens: refilled,
      retryAfterMs: Math.ceil(((1 - refilled) * 1000) / config.refillPerSecond),
      snapshot: { tokens: refilled, lastRefillAt: now },
    };
  }

  const tokens = refilled - 1;
  return {
    allowed: true,
    tokens,
    retryAfterMs: 0,
    snapshot: { tokens, lastRefillAt: now },
  };
}

export function tenantRateLimitKey(tenantId: string): string {
  return `waybill:rate-limit:tenant:${tenantId}`;
}

export async function consumeTenantToken(
  client: Redis,
  tenantId: string,
  overrides?: Partial<RateLimitConfig>,
  now = Date.now(),
): Promise<TokenBucketDecision> {
  const config = normalizeRateLimitConfig(overrides);
  const result = (await client.eval(
    CONSUME_TOKEN_SCRIPT,
    1,
    tenantRateLimitKey(tenantId),
    String(config.capacity),
    String(config.refillPerSecond),
    String(now),
  )) as [number, number, number];

  return {
    allowed: result[0] === 1,
    tokens: result[1],
    retryAfterMs: result[2],
  };
}