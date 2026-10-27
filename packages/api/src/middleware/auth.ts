import type { RequestHandler, Express } from "express";
import { authFailure } from "../controllers/auth";
import { AuthError, type AuthService } from "../services/auth";

export function authCors(service: AuthService): RequestHandler {
  return (req, res, next) => {
    if (service.config.mode !== "session") { next(); return; }
    const origin = req.get("Origin");
    res.vary("Origin");
    if (origin === service.config.webOrigin) {
      res.set({ "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" });
      if (req.method === "OPTIONS") {
        res.set({ "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token", "Access-Control-Max-Age": "600" });
        res.status(204).end(); return;
      }
    } else if (req.method === "OPTIONS") { res.status(403).end(); return; }
    next();
  };
}
export function installTenantAuthorization(app: Express, service: AuthService) {
  if (service.config.mode !== "session") return;
  function guard(fromBody: boolean): RequestHandler {
    return (req, res, next) => {
      res.set("Cache-Control", "no-store");
      service.authorize(req.headers.cookie, fromBody ? req.body?.tenantId : req.params.tenantId,
        req.method, req.get("Origin"), req.get("X-CSRF-Token")).then(() => next()).catch((error: unknown) => {
          req.log?.warn({ status: error instanceof AuthError ? error.status : 503 }, "Tenant access rejected");
          authFailure(error, res);
        });
    };
  }
  app.post("/events", guard(true));
  app.use("/tenants/:tenantId", guard(false));
}
