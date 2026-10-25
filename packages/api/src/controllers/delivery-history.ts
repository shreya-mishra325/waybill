import type { Request, Response } from "express";
import { DeliveryHistoryValidationError } from "../services/delivery-history-query";
import { DeliveryHistoryUnavailableError, getDeliveryHistory } from "../services/delivery-history";

export async function getDeliveries(req: Request, res: Response): Promise<void> {
  try {
    res.status(200).json(await getDeliveryHistory(req.params.tenantId, req.query));
  } catch (error) {
    if (error instanceof DeliveryHistoryValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof DeliveryHistoryUnavailableError) {
      req.log.error({ err: error }, "Delivery history replica read failed");
      res.status(503).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "GET delivery history failed");
    res.status(500).json({ error: "internal error" });
  }
}
