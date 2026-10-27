import { z } from "zod";
import type { AuthConfig } from "./auth-config";
import { authRepository, type AuthRepository, type Session } from "../repositories/auth";
import { githubIdentity } from "./github-auth";
import { cookieNames, cookieToken, newToken, tokenHash, tokensEqual, validToken } from "./auth-tokens";

export class AuthError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const LOGIN_SECONDS = 5 * 60;
const callbackSchema = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(1024) });

export function createAuthService(config: AuthConfig, store: AuthRepository = authRepository, request: typeof fetch = fetch) {
  function enabled() {
    if (config.mode !== "session") throw new AuthError(503, "GitHub sign-in is not enabled");
    return config;
  }
  async function session(cookie: string | undefined) {
    const settings = enabled();
    const token = cookieToken(cookie, cookieNames(settings.secure).session);
    if (!token) throw new AuthError(401, "Sign in required");
    const result = await store.findSession(tokenHash(token), new Date());
    if (!result) throw new AuthError(401, "Session expired or revoked");
    return result;
  }
  function csrf(current: Session, origin: string | undefined, token: string | undefined) {
    const settings = enabled();
    if (origin !== settings.webOrigin || !validToken(token) || !tokensEqual(current.csrfToken, token)) {
      throw new AuthError(403, "Invalid request origin or CSRF token");
    }
  }
  return {
    config, session, csrf,
    async begin() {
      const settings = enabled();
      const state = newToken();
      const browser = newToken();
      const verifier = newToken();
      await store.createLogin({ stateHash: tokenHash(state), browserHash: tokenHash(browser), codeVerifier: verifier,
        expiresAt: new Date(Date.now() + LOGIN_SECONDS * 1000) });
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: settings.apiOrigin + "/auth/github/callback",
        state, code_challenge: Buffer.from(tokenHash(verifier), "hex").toString("base64url"), code_challenge_method: "S256", scope: "" }).toString();
      return { url: url.toString(), browser };
    },
    async complete(query: unknown, cookie: string | undefined) {
      const settings = enabled();
      const parsed = callbackSchema.safeParse(query);
      const browser = cookieToken(cookie, cookieNames(settings.secure).oauth);
      if (!parsed.success || !browser) throw new AuthError(400, "Invalid or denied GitHub callback");
      const attempt = await store.consumeLogin(tokenHash(parsed.data.state), tokenHash(browser), new Date());
      if (!attempt) throw new AuthError(400, "Sign-in request expired or already used");
      let identity: Awaited<ReturnType<typeof githubIdentity>>;
      try { identity = await githubIdentity(settings, parsed.data.code, attempt.codeVerifier, request); }
      catch { throw new AuthError(502, "GitHub sign-in failed; start again"); }
      const token = newToken();
      const previous = cookieToken(cookie, cookieNames(settings.secure).session);
      await store.createSession(identity, { tokenHash: tokenHash(token), csrfToken: newToken(),
        expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000) }, previous ? tokenHash(previous) : undefined);
      return token;
    },
    async authorize(cookie: string | undefined, tenantId: unknown, method: string, origin?: string, csrfToken?: string) {
      const current = await session(cookie);
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) csrf(current, origin, csrfToken);
      const parsed = z.string().uuid().safeParse(tenantId);
      if (!parsed.success) throw new AuthError(400, "Invalid tenant ID");
      if (!current.user.memberships.some(member => member.tenant.id === parsed.data)) throw new AuthError(404, "Tenant not found");
      return current;
    },
    async me(cookie: string | undefined) {
      const current = await session(cookie);
      return { user: { id: current.user.id, githubId: current.user.githubId, githubLogin: current.user.githubLogin },
        tenants: current.user.memberships.map(member => member.tenant), csrfToken: current.csrfToken, expiresAt: current.expiresAt };
    },
    async logout(cookie: string | undefined, origin: string | undefined, token: string | undefined) {
      const current = await session(cookie);
      csrf(current, origin, token);
      await store.deleteSession(current.tokenHash);
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;
