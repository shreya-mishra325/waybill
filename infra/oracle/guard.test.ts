import { expect, test } from "bun:test";
import { healthyBackup, healthPermission, permission, readMetric, readPlan, readPolicy, validLease, withinUsage } from "./guard";

const now = Date.parse("2026-11-05T00:00:00Z");
const day = 86400000;
const input = { accountId: "123456789012", startsAt: "2026-11-05T00:00:00Z", endsAt: "2027-01-04T00:00:00Z", benefitsExpireAt: "2027-02-01T00:00:00Z", minimumCreditsUsd: 5, maxSqsPerHour: 25000, maxWritesPerHour: 1000, maxArchiveReadsPerHour: 1000, coveredServicesVerified: true };
const account = { accountId: input.accountId, accountPlanType: "FREE", accountPlanStatus: "ACTIVE", accountPlanExpirationDate: input.benefitsExpireAt, accountPlanRemainingCredits: { amount: 100, unit: "USD" } };
const policy = readPolicy(input);
const plan = readPlan(account, policy);

test("coverage must be explicit; malformed, oversized-window and zero-reserve policies deny", () => {
  for (const value of [null, {}, { ...input, coveredServicesVerified: false }, { ...input, accountId: "a" }, { ...input, endsAt: "2027-03-01" }, { ...input, minimumCreditsUsd: 0 }]) expect(() => readPolicy(value)).toThrow();
});
test("wrong-account, paid, legacy, expired and non-USD plan responses deny", () => {
  for (const value of [{}, { ...account, accountId: "999999999999" }, { ...account, accountPlanType: "PAID" }, { ...account, accountPlanStatus: "EXPIRED" }, { ...account, accountPlanRemainingCredits: { amount: 100, unit: "INR" } }, { ...account, accountPlanRemainingCredits: { amount: NaN, unit: "USD" } }]) expect(() => readPlan(value, policy)).toThrow();
});
test("valid coverage produces a short lease, independent of the service lifetime", () => {
  const lease = permission(policy, plan, now);
  expect(validLease(lease, now + 179000)).toBe(true);
  expect(validLease(lease, now + 180000)).toBe(false);
  expect(lease.cutoff).toBe(policy.endsAt);
});
test("startup before the window, end of the window, expiry margin and credit reserve all deny", () => {
  expect(() => permission(policy, plan, now - 1)).toThrow();
  expect(() => permission(policy, plan, policy.endsAt)).toThrow();
  expect(() => permission(policy, { ...plan, expiresAt: now + 3 * day }, now)).toThrow();
  expect(() => permission(policy, { ...plan, credits: 5 }, now)).toThrow();
  expect(permission(policy, { ...plan, expiresAt: now + 4 * day }, now).cutoff).toBe(now + day);
});
test("malformed and excessively long leases cannot authorize a backend", () => {
  for (const lease of [null, {}, { issuedAt: now, validUntil: now + day, cutoff: now + day }, { issuedAt: now + 6000, validUntil: now + 12000, cutoff: now + day }, { issuedAt: now, validUntil: now + 1000, cutoff: now }]) expect(validLease(lease, now)).toBe(false);
});
test("health failures have a bounded startup/restart grace, never an unlimited reset", () => {
  expect(healthPermission(false, null, now)).toBe(now);
  expect(healthPermission(false, now, now + 119000)).toBe(now);
  expect(() => healthPermission(false, now, now + 120000)).toThrow();
  expect(healthPermission(true, now, now + 120000)).toBeNull();
});
test("backups must be current and not forged into the future", () => {
  expect(healthyBackup(now - day, now)).toBe(true);
  for (const stamp of [0, NaN, now - 2 * day, now + 60000]) expect(healthyBackup(stamp, now)).toBe(false);
});
test("usage circuits include sampler allowance and fail on non-finite or excessive samples", () => {
  expect(withinUsage(policy, 1800, 0, 0)).toBe(true);
  for (const values of [[25000, 0, 0], [0, 1001, 0], [0, 0, 1001], [NaN, 0, 0], [-1, 0, 0]]) expect(withinUsage(policy, values[0], values[1], values[2])).toBe(false);
});

import { idleRequests } from "./estimate";
test("idle request estimate accounts for ten parallel receive calls", () => {
  expect(idleRequests(60, 10, 20, 30)).toEqual({ receive: 2592000, sample: 172800, total: 2764800 });
});

test("malformed, NaN, infinite and ambiguous monitoring evidence cannot renew permission", () => {
  const raw = (values: unknown[]) => ({ status: "success", data: { resultType: "vector", result: values } });
  expect(readMetric(raw([{ value: [now / 1000, "3"] }]), false)).toBe(3);
  expect(readMetric(raw([]), true)).toBe(0);
  expect(() => readMetric(raw([]), false)).toThrow();
  for (const value of ["NaN", "+Inf", "", "-1"]) expect(() => readMetric(raw([{ value: [now / 1000, value] }]), true)).toThrow();
  expect(() => readMetric(raw([{ value: [0, "1"] }, { value: [0, "2"] }]), true)).toThrow();
});
