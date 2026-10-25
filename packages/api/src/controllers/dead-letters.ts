import type { Request, Response } from "express";
import { DeadLetterValidationError } from "../services/dead-letter-query";
import { ArchivedPayloadGoneError, ArchivedPayloadInvalidError, DeadLetterNotFoundError,
  DeadLetterUnavailableError, getDeadLetterPayload, getDeadLetters } from "../services/dead-letters";

import { ReplayConflictError } from "../services/replay-query";
import { requestReplay } from "../services/replays";

function handleError(error: unknown, req: Request, res: Response): void {
  if (error instanceof DeadLetterValidationError) { res.status(400).json({ error: error.message }); return; }
  if (error instanceof DeadLetterNotFoundError) { res.status(404).json({ error: error.message }); return; }
  if (error instanceof ArchivedPayloadGoneError) { res.status(410).json({ error: error.message }); return; }
  if (error instanceof ReplayConflictError) { res.status(409).json({ error: error.message }); return; }
  req.log.error({ err: error }, "Dead-letter operation failed");
  if (error instanceof ArchivedPayloadInvalidError) { res.status(502).json({ error: error.message }); return; }
  if (error instanceof DeadLetterUnavailableError) { res.status(503).json({ error: error.message }); return; }
  res.status(500).json({ error: "internal error" });
}

export async function getDeadLetterList(req: Request, res: Response): Promise<void> {
  try { res.json(await getDeadLetters(req.params.tenantId, req.query)); }
  catch (error) { handleError(error, req, res); }
}

export async function getPayload(req: Request, res: Response): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(await getDeadLetterPayload(req.params.tenantId, req.params.deadLetterId, req.query)); }
  catch (error) { handleError(error, req, res); }
}

export async function postReplay(req: Request, res: Response): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.status(202).json(await requestReplay(req.params.tenantId, req.params.deadLetterId,
      req.get("Idempotency-Key"), req.body, req.query));
  } catch (error) { handleError(error, req, res); }
}
