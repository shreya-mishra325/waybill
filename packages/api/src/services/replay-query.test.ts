import { expect, test } from "bun:test";
import { parseReplayQuery } from "./replay-query";

const tenantId = crypto.randomUUID();
const deadLetterId = crypto.randomUUID();
const key = crypto.randomUUID();

test("replay requires a UUID idempotency key and no caller-controlled payload or destination", () => {
  expect(parseReplayQuery(tenantId, deadLetterId, key, undefined, {}).idempotencyKey).toBe(key);
  expect(parseReplayQuery(tenantId, deadLetterId, key, {}, {}).deadLetterId).toBe(deadLetterId);
  for (const invalid of [undefined, "", "not-a-uuid", `${key},${key}`]) {
    expect(() => parseReplayQuery(tenantId, deadLetterId, invalid, {}, {})).toThrow();
  }
  for (const body of [null, [], {payload: {}}, {targetUrl: "http://elsewhere"}, {idempotencyKey: key}]) {
    expect(() => parseReplayQuery(tenantId, deadLetterId, key, body, {})).toThrow();
  }
  expect(() => parseReplayQuery("invalid", deadLetterId, key, {}, {})).toThrow();
  expect(() => parseReplayQuery(tenantId, "invalid", key, {}, {})).toThrow();
  expect(() => parseReplayQuery(tenantId, deadLetterId, key, {}, {force: "true"})).toThrow();
});
