import { z } from "zod";
import { DeadLetterValidationError } from "./dead-letter-query";

const schema = z.object({
  tenantId: z.string().uuid(), deadLetterId: z.string().uuid(), idempotencyKey: z.string().uuid(),
  body: z.object({}).strict(), query: z.object({}).strict(),
});
export class ReplayConflictError extends Error {}

export function parseReplayQuery(tenantId: unknown, deadLetterId: unknown,
  idempotencyKey: unknown, body: unknown, query: unknown) {
  const input = schema.safeParse({tenantId, deadLetterId, idempotencyKey, body: body === undefined ? {} : body, query});
  if (!input.success) throw new DeadLetterValidationError("Replay requires valid tenant and record IDs, a UUID Idempotency-Key, and no request fields");
  return input.data;
}
