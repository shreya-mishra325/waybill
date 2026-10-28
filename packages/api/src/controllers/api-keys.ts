import type { RequestHandler } from "express";
import { authFailure } from "./auth";
import { AuthError } from "../services/auth";
import type { ApiKeyService } from "../services/api-keys";

export function apiKeyControllers(service: ApiKeyService) {
  function handle(action: RequestHandler): RequestHandler {
    return (req, res, next) => {
      res.set("Cache-Control", "no-store");
      Promise.resolve().then(() => action(req, res, next)).catch((error: unknown) => {
        req.log?.warn({ status: error instanceof AuthError ? error.status : 503 }, "API key operation rejected");
        authFailure(error, res);
      });
    };
  }
  return {
    issue: handle(async (req, res) => { res.status(201).json(await service.issue(req.headers.cookie, req.params.tenantId, req.get("Origin"), req.get("X-CSRF-Token"), req.body)); }),
    list: handle(async (req, res) => { res.json(await service.list(req.headers.cookie, req.params.tenantId, req.query)); }),
    revoke: handle(async (req, res) => { res.json(await service.revoke(req.headers.cookie, req.params.tenantId, req.params.keyId, req.get("Origin"), req.get("X-CSRF-Token"))); }),
  };
}
