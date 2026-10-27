export type AuthConfig = { mode: "development" } | {
  mode: "session"; apiOrigin: string; webOrigin: string; secure: boolean; clientId: string; clientSecret: string;
};

export function authConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const production = env.NODE_ENV === "production";
  const mode = env.API_AUTH_MODE ?? (production ? "session" : "development");
  if (mode === "development") {
    if (production) throw new Error("Development authentication bypass is forbidden in production");
    return { mode };
  }
  if (mode !== "session") throw new Error("API_AUTH_MODE must be development or session");
  function required(name: string) {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing authentication setting: ${name}`);
    return value;
  }
  function origin(name: string) {
    const value = required(name);
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`Invalid authentication origin: ${name}`); }
    const localHttp = !production && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!localHttp && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`Use an HTTPS origin or a development loopback origin for ${name}`);
    }
    return url.origin;
  }
  const apiOrigin = origin("AUTH_API_ORIGIN");
  const webOrigin = origin("AUTH_WEB_ORIGIN");
  if (new URL(apiOrigin).protocol !== new URL(webOrigin).protocol) throw new Error("Authentication origins must use the same scheme");
  return { mode, apiOrigin, webOrigin, secure: apiOrigin.startsWith("https:"),
    clientId: required("GITHUB_CLIENT_ID"), clientSecret: required("GITHUB_CLIENT_SECRET") };
}
