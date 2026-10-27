import { expect } from "bun:test";
import type { AuthConfig } from "../services/auth-config";
import { createAuthService } from "../services/auth";
import { newToken, tokenHash } from "../services/auth-tokens";
import type { AuthRepository, Session } from "../repositories/auth";

export const settings: Extract<AuthConfig, { mode: "session" }> = { mode: "session", apiOrigin: "http://127.0.0.1:3000",
  webOrigin: "http://127.0.0.1:3001", secure: false, clientId: "test-client", clientSecret: "test-secret" };
export function fixture() {
  const logins = new Map<string, Parameters<AuthRepository["createLogin"]>[0]>();
  const sessions = new Map<string, Session>();
  const tenantId = crypto.randomUUID();
  let memberships = [{ tenant: { id: tenantId, name: "owned" } }];
  let unavailable = false;
  let githubRequests = 0;
  let lastVerifier = "";
  const store: AuthRepository = {
    async createLogin(row) { logins.set(row.stateHash, row); },
    async consumeLogin(stateHash, browserHash, now) {
      const row = logins.get(stateHash);
      if (!row || row.browserHash !== browserHash || row.expiresAt <= now) return null;
      logins.delete(stateHash); return row;
    },
    async createSession(identity, row, previousHash) {
      if (previousHash) sessions.delete(previousHash);
      sessions.set(row.tokenHash, { ...row, user: { id: "user", ...identity, memberships } });
    },
    async findSession(hash, now) {
      if (unavailable) throw new Error("database unavailable");
      const row = sessions.get(hash);
      return row && row.expiresAt > now ? { ...row, user: { ...row.user, memberships } } : null;
    },
    async deleteSession(hash) { sessions.delete(hash); },
  };
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    githubRequests++;
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    if (input === "https://github.com/login/oauth/access_token") {
      const body = init?.body as URLSearchParams;
      expect(body.get("client_secret")).toBe(settings.clientSecret);
      expect(body.get("redirect_uri")).toBe(settings.apiOrigin + "/auth/github/callback");
      lastVerifier = body.get("code_verifier")!;
      return Response.json({ access_token: "github-token", token_type: "bearer" });
    }
    expect(input).toBe("https://api.github.com/user");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer github-token");
    return Response.json({ id: 12345, login: "developer" });
  }) as typeof fetch;
  const service = createAuthService(settings, store, request);
  async function login(previous?: string) {
    const begin = await service.begin();
    const state = new URL(begin.url).searchParams.get("state")!;
    const token = await service.complete({ state, code: "code" }, `waybill-oauth=${begin.browser}${previous ? `; waybill-session=${previous}` : ""}`);
    return { token, cookie: `waybill-session=${token}`, state, begin };
  }
  return { service, store, sessions, logins, tenantId, login, request,
    revokeMembership: () => { memberships = []; }, failDatabase: () => { unavailable = true; },
    githubRequests: () => githubRequests, lastVerifier: () => lastVerifier };
}

