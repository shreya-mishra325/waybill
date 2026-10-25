import { expect, test } from "bun:test";
import { deadLetterCursor, parseDeadLetterPayloadQuery, parseDeadLetterQuery } from "./dead-letter-query";

const tenantId = crypto.randomUUID();

test("dead-letter pages validate size and bind cursors to tenant and resource", () => {
  const query = parseDeadLetterQuery(tenantId, {});
  expect(query.limit).toBe(50);
  expect(parseDeadLetterQuery(tenantId, { limit: "100" }).limit).toBe(100);
  const row = { id: crypto.randomUUID(), createdAt: new Date("2026-10-25T00:00:00Z") };
  const cursor = deadLetterCursor(query, row);
  expect(parseDeadLetterQuery(tenantId, { cursor }).cursor).toEqual(row);
  expect(() => parseDeadLetterQuery(crypto.randomUUID(), { cursor })).toThrow();
  const wrongResource = Buffer.from(JSON.stringify({ tenantId, status: null,
    createdAt: row.createdAt.toISOString(), id: row.id })).toString("base64url");
  expect(() => parseDeadLetterQuery(tenantId, { cursor: wrongResource })).toThrow();
  for (const input of [{limit:"0"},{limit:"101"},{limit:"1.2"},{limit:["1","2"]},
    {status:"FAILED"},{cursor:"%%%"},{cursor:"x".repeat(1025)}]) {
    expect(() => parseDeadLetterQuery(tenantId, input)).toThrow();
  }
});

test("payload lookup accepts only tenant and record IDs, not a caller-supplied S3 key", () => {
  const id = crypto.randomUUID();
  expect(parseDeadLetterPayloadQuery(tenantId, id, {}).deadLetterId).toBe(id);
  expect(() => parseDeadLetterPayloadQuery("invalid", id, {})).toThrow();
  expect(() => parseDeadLetterPayloadQuery(tenantId, "invalid", {})).toThrow();
  expect(() => parseDeadLetterPayloadQuery(tenantId, id, { key: "somebody-elses-payload" })).toThrow();
});
