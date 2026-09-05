const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 8;

export function maxDeliveryAttempts(): number {
  const raw = process.env.MAX_DELIVERY_ATTEMPTS;
  if (!raw) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("MAX_DELIVERY_ATTEMPTS must be a positive number");
  }
  return parsed;
}

export function isExhausted(attemptCount: number): boolean {
  return attemptCount >= maxDeliveryAttempts();
}

export function backoffDelayMs(attemptCount: number): number {
  const exp = Math.min(
    BASE_DELAY_MS * 2 ** Math.max(attemptCount - 1, 0),
    MAX_DELAY_MS,
  );
  // Full jitter: sleep is random in [0, exp], not exactly exp.
  // Without jitter, every worker that failed at the same time wakes
  // together and hits the sick endpoint as a herd.
  return Math.floor(Math.random() * (exp + 1));
}

export function nextAttemptAt(attemptCount: number, now = new Date()): Date {
  return new Date(now.getTime() + backoffDelayMs(attemptCount));
}

export function visibilityTimeoutSeconds(delayMs: number): number {
  const seconds = Math.ceil(delayMs / 1000);
  return Math.min(Math.max(seconds, 1), 43_200);
}
