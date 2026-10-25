import { z } from "zod";

const status = z.enum(["PENDING", "IN_FLIGHT", "SUCCEEDED", "FAILED", "DEAD_LETTERED"]);
const inputSchema = z.object({
  tenantId: z.string().uuid(),
  query: z.object({
    status: status.optional(),
    limit: z.string().regex(/^[1-9][0-9]*$/).default("50")
      .transform(Number).refine(value => value <= 100),
    cursor: z.string().min(1).max(1024).optional(),
  }).strict(),
});
const cursorSchema = z.object({
  tenantId: z.string().uuid(),
  status: status.nullable(),
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
}).strict();

export class DeliveryHistoryValidationError extends Error {}

export type DeliveryHistoryQuery = {
  tenantId: string;
  status?: z.infer<typeof status>;
  limit: number;
  cursor?: { createdAt: Date; id: string };
};

export function parseDeliveryHistoryQuery(tenantId: unknown, query: unknown): DeliveryHistoryQuery {
  const parsed = inputSchema.safeParse({ tenantId, query });
  if (!parsed.success) throw new DeliveryHistoryValidationError("Invalid tenant ID or delivery history query");
  const result: DeliveryHistoryQuery = { tenantId: parsed.data.tenantId,
    status: parsed.data.query.status, limit: parsed.data.query.limit };
  const encoded = parsed.data.query.cursor;
  if (encoded !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid encoding");
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) throw new Error("Invalid encoding");
      const cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (cursor.tenantId !== result.tenantId || cursor.status !== (result.status ?? null)) {
        throw new Error("Cursor does not match tenant and filter");
      }
      result.cursor = { createdAt: new Date(cursor.createdAt), id: cursor.id };
    } catch {
      throw new DeliveryHistoryValidationError("Invalid cursor for this tenant and status filter");
    }
  }
  return result;
}

export function deliveryHistoryCursor(query: DeliveryHistoryQuery, row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ tenantId: query.tenantId, status: query.status ?? null,
    createdAt: row.createdAt.toISOString(), id: row.id })).toString("base64url");
}
