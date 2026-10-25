import type { Request, Response } from "express";
import { DeliveryHistoryValidationError } from "../services/delivery-history-query";
import { DeliverySummaryUnavailableError, getDeliverySummary } from "../services/delivery-summary";

export async function getSummary(req: Request, res: Response): Promise<void> {
  try {
    res.status(200).json(await getDeliverySummary(req.params.tenantId, req.query));
  } catch (error) {
    if (error instanceof DeliveryHistoryValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof DeliverySummaryUnavailableError) {
      req.log.error({ err: error }, "Delivery summary replica read failed");
      res.status(503).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "GET delivery summary failed");
    res.status(500).json({ error: "internal error" });
  }
}
