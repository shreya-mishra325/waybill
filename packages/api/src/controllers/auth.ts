import type { RequestHandler, Response, CookieOptions } from "express";
import { AuthError, LOGIN_SECONDS, SESSION_SECONDS, type AuthService } from "../services/auth";
import { cookieNames } from "../services/auth-tokens";

export function authFailure(error: unknown, res: Response) {
  if (error instanceof AuthError) res.status(error.status).json({ error: error.message });
  else res.status(503).json({ error: "Authentication is temporarily unavailable" });
}
export function authControllers(service: AuthService) {
  const secure = service.config.mode === "session" && service.config.secure;
  const names = cookieNames(secure);
  const options: CookieOptions = { httpOnly: true, secure, sameSite: "lax", path: "/" };
  function handle(action: RequestHandler): RequestHandler {
    return (req, res, next) => {
      res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      Promise.resolve().then(() => action(req, res, next)).catch((error: unknown) => {
        req.log?.warn({ status: error instanceof AuthError ? error.status : 503 }, "Authentication request rejected");
        authFailure(error, res);
      });
    };
  }
  return {
    begin: handle(async (_req, res) => {
      const result = await service.begin();
      res.cookie(names.oauth, result.browser, { ...options, maxAge: LOGIN_SECONDS * 1000 });
      res.redirect(302, result.url);
    }),
    complete: handle(async (req, res) => {
      res.clearCookie(names.oauth, options);
      const token = await service.complete(req.query, req.headers.cookie);
      res.cookie(names.session, token, { ...options, maxAge: SESSION_SECONDS * 1000 });
      if (service.config.mode === "session") res.redirect(303, service.config.webOrigin + "/");
    }),
    me: handle(async (req, res) => { res.json(await service.me(req.headers.cookie)); }),
    logout: handle(async (req, res) => {
      await service.logout(req.headers.cookie, req.get("Origin"), req.get("X-CSRF-Token"));
      res.clearCookie(names.session, options);
      res.status(204).end();
    }),
  };
}
