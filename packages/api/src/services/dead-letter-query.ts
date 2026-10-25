import { z } from "zod";

const tenant = z.string().uuid();
const listSchema = z.object({ tenantId: tenant, query: z.object({
  limit: z.string().regex(/^[1-9][0-9]*$/).default("50").transform(Number).refine(n => n <= 100),
  cursor: z.string().min(1).max(1024).optional(),
}).strict() });
const cursorSchema = z.object({ resource: z.literal("dead-letters"), tenantId: tenant,
  createdAt: z.string().datetime(), id: z.string().uuid() }).strict();

export class DeadLetterValidationError extends Error {}
export type DeadLetterQuery = { tenantId: string; limit: number; cursor?: { createdAt: Date; id: string } };

export function parseDeadLetterQuery(tenantId: unknown, query: unknown): DeadLetterQuery {
  const parsed = listSchema.safeParse({ tenantId, query });
  if (!parsed.success) throw new DeadLetterValidationError("Invalid tenant ID or dead-letter query");
  const result: DeadLetterQuery = { tenantId: parsed.data.tenantId, limit: parsed.data.query.limit };
  const encoded = parsed.data.query.cursor;
  if (encoded !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid encoding");
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) throw new Error("Invalid encoding");
      const cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (cursor.tenantId !== result.tenantId) throw new Error("Wrong tenant");
      result.cursor = { createdAt: new Date(cursor.createdAt), id: cursor.id };
    } catch {
      throw new DeadLetterValidationError("Invalid dead-letter cursor for this tenant");
    }
  }
  return result;
}

export function deadLetterCursor(query: DeadLetterQuery, row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ resource: "dead-letters", tenantId: query.tenantId,
    createdAt: row.createdAt.toISOString(), id: row.id })).toString("base64url");
}

export function parseDeadLetterPayloadQuery(tenantId: unknown, deadLetterId: unknown, query: unknown) {
  const parsed = z.object({ tenantId: tenant, deadLetterId: z.string().uuid(), query: z.object({}).strict() })
    .safeParse({ tenantId, deadLetterId, query });
  if (!parsed.success) throw new DeadLetterValidationError("Invalid tenant ID, dead-letter ID, or payload query");
  return parsed.data;
}
