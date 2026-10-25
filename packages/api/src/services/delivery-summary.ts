import { z } from "zod";
import { countDeliveriesByStatus } from "../repositories/delivery-summary";
import { DeliveryHistoryValidationError } from "./delivery-history-query";
import { summarizeDeliveries } from "./delivery-summary-values";

const inputSchema = z.object({ tenantId: z.string().uuid(), query: z.object({}).strict() });

export class DeliverySummaryUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Delivery summary is temporarily unavailable", { cause });
  }
}

export async function getDeliverySummary(tenantId: unknown, query: unknown) {
  const input = inputSchema.safeParse({ tenantId, query });
  if (!input.success) throw new DeliveryHistoryValidationError("Invalid tenant ID or delivery summary query");
  let rows: Awaited<ReturnType<typeof countDeliveriesByStatus>>;
  try {
    rows = await countDeliveriesByStatus(input.data.tenantId);
  } catch (cause) {
    throw new DeliverySummaryUnavailableError(cause);
  }
  return summarizeDeliveries(rows);
}
