import Redis from "ioredis";

export type CircuitState = "closed" | "open" | "half-open";

export type CircuitConfig = {
  failureThreshold: number;
  cooldownMs: number;
};

export type CircuitSnapshot = {
  state: CircuitState;
  failureCount: number;
  openedAt?: number;
  halfOpenInFlight?: boolean;
};

const DEFAULT_CONFIG: CircuitConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
};

export function normalizeConfig(overrides?: Partial<CircuitConfig>): CircuitConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
  };
}

export function applyFailure(
  current: CircuitSnapshot,
  now = Date.now(),
  overrides?: Partial<CircuitConfig>,
): CircuitSnapshot {
  const config = normalizeConfig(overrides);
  const nextFailureCount = current.failureCount + 1;

  if (current.state === "open") {
    return {
      state: "open",
      failureCount: current.failureCount,
      openedAt: current.openedAt ?? now,
      halfOpenInFlight: false,
    };
  }

  if (current.state === "half-open") {
    return {
      state: "open",
      failureCount: config.failureThreshold,
      openedAt: now,
      halfOpenInFlight: false,
    };
  }

  if (nextFailureCount >= config.failureThreshold) {
    return {
      state: "open",
      failureCount: config.failureThreshold,
      openedAt: now,
      halfOpenInFlight: false,
    };
  }

  return {
    state: "closed",
    failureCount: nextFailureCount,
    openedAt: undefined,
    halfOpenInFlight: false,
  };
}

export function applySuccess(
  _current: CircuitSnapshot,
  _now = Date.now(),
  _overrides?: Partial<CircuitConfig>,
): CircuitSnapshot {
  return {
    state: "closed",
    failureCount: 0,
    openedAt: undefined,
    halfOpenInFlight: false,
  };
}

export function getCircuitDecision(
  current: CircuitSnapshot,
  now = Date.now(),
  overrides?: Partial<CircuitConfig>,
): {
  allowed: boolean;
  state: CircuitState;
  delayMs: number;
} {
  const config = normalizeConfig(overrides);

  if (current.state === "open") {
    const openedAt = current.openedAt ?? now;
    const remaining = config.cooldownMs - (now - openedAt);
    if (remaining > 0) {
      return {
        allowed: false,
        state: "open",
        delayMs: remaining,
      };
    }

    return {
      allowed: true,
      state: "half-open",
      delayMs: 0,
    };
  }

  if (current.state === "half-open") {
    return {
      allowed: !current.halfOpenInFlight,
      state: "half-open",
      delayMs: 0,
    };
  }

  return {
    allowed: true,
    state: "closed",
    delayMs: 0,
  };
}

function requireRedisUrl(): string {
  const value = process.env.REDIS_URL;
  if (!value) {
    throw new Error("Missing required env var: REDIS_URL");
  }
  return value;
}

export function createRedisClient(): Redis {
  return new Redis(requireRedisUrl(), {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 3,
  });
}

export function circuitKeyForTarget(targetUrl: string): string {
  return `waybill:circuit:${targetUrl}`;
}

export async function readCircuitState(
  client: Redis,
  targetUrl: string,
): Promise<CircuitSnapshot> {
  const key = circuitKeyForTarget(targetUrl);
  const raw = await client.hgetall(key);
  if (!raw || Object.keys(raw).length === 0) {
    return { state: "closed", failureCount: 0 };
  }

  return {
    state: (raw.state as CircuitState) ?? "closed",
    failureCount: Number(raw.failureCount ?? 0),
    openedAt: raw.openedAt ? Number(raw.openedAt) : undefined,
    halfOpenInFlight: raw.halfOpenInFlight === "true",
  };
}

export async function writeCircuitState(
  client: Redis,
  targetUrl: string,
  snapshot: CircuitSnapshot,
  overrides?: Partial<CircuitConfig>,
): Promise<void> {
  const config = normalizeConfig(overrides);
  const key = circuitKeyForTarget(targetUrl);
  await client.hset(key, {
    state: snapshot.state,
    failureCount: String(snapshot.failureCount),
    openedAt: snapshot.openedAt ? String(snapshot.openedAt) : "",
    halfOpenInFlight: snapshot.halfOpenInFlight ? "true" : "false",
  });
  await client.expire(key, Math.max(1, Math.ceil(config.cooldownMs / 1000)));
}

export async function recordDeliveryFailure(
  client: Redis,
  targetUrl: string,
  overrides?: Partial<CircuitConfig>,
): Promise<CircuitSnapshot> {
  const config = normalizeConfig(overrides);
  const current = await readCircuitState(client, targetUrl);
  const next = applyFailure(current, Date.now(), config);
  await writeCircuitState(client, targetUrl, next, config);
  return next;
}

export async function recordDeliverySuccess(
  client: Redis,
  targetUrl: string,
  overrides?: Partial<CircuitConfig>,
): Promise<CircuitSnapshot> {
  const config = normalizeConfig(overrides);
  const current = await readCircuitState(client, targetUrl);
  const next = applySuccess(current, Date.now(), config);
  await writeCircuitState(client, targetUrl, next, config);
  return next;
}

export async function shouldAllowDelivery(
  client: Redis,
  targetUrl: string,
  overrides?: Partial<CircuitConfig>,
): Promise<{ allowed: boolean; state: CircuitState; delayMs: number; snapshot: CircuitSnapshot }> {
  const config = normalizeConfig(overrides);
  const snapshot = await readCircuitState(client, targetUrl);
  const decision = getCircuitDecision(snapshot, Date.now(), config);
  return {
    ...decision,
    snapshot,
  };
}
