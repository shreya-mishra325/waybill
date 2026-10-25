import { listDeliveryHistory } from "../repositories/delivery-history";
import { deliveryHistoryCursor, parseDeliveryHistoryQuery } from "./delivery-history-query";

export class DeliveryHistoryUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Delivery history is temporarily unavailable", { cause });
  }
}

export async function getDeliveryHistory(tenantId: unknown, input: unknown) {
  const query = parseDeliveryHistoryQuery(tenantId, input);
  let rows: Awaited<ReturnType<typeof listDeliveryHistory>>;
  try {
    rows = await listDeliveryHistory(query);
  } catch (cause) {
    throw new DeliveryHistoryUnavailableError(cause);
  }
  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > query.limit && last ? deliveryHistoryCursor(query, last) : null,
  };
}
