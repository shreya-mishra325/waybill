import { z } from "zod";
import type { AuthConfig } from "./auth-config";

const identitySchema = z.object({ id: z.number().int().positive().safe(), login: z.string().min(1).max(100) });
const tokenSchema = z.object({ access_token: z.string().min(1), token_type: z.string().refine(value => value.toLowerCase() === "bearer") });
export async function githubIdentity(config: Extract<AuthConfig, { mode: "session" }>, code: string, verifier: string, request: typeof fetch = fetch) {
  const tokenResponse = await request("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code,
      redirect_uri: config.apiOrigin + "/auth/github/callback", code_verifier: verifier }),
    redirect: "error", signal: AbortSignal.timeout(10000),
  });
  if (!tokenResponse.ok) throw new Error("GitHub token exchange failed");
  const token = tokenSchema.parse(await tokenResponse.json());
  const userResponse = await request("https://api.github.com/user", { headers: {
    Accept: "application/vnd.github+json", Authorization: `Bearer ${token.access_token}`,
    "User-Agent": "Waybill", "X-GitHub-Api-Version": "2022-11-28",
  }, redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!userResponse.ok) throw new Error("GitHub identity lookup failed");
  const identity = identitySchema.parse(await userResponse.json());
  return { githubId: String(identity.id), githubLogin: identity.login };
}
