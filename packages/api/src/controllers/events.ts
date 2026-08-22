import type { Request, Response } from "express";
import {
  TenantNotFoundError,
  ValidationError,
  ingestEvent,
} from "../services/events";

export async function postEvent(req: Request, res: Response): Promise<void> {
  try {
    const result = await ingestEvent(req.body);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof TenantNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }

    req.log.error({ err }, "POST /events failed");
    res.status(500).json({ error: "internal error" });
  }
}
