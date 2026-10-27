# GitHub sign-in and tenant access

## Current status

The API implements GitHub sign-in, server-side sessions, CSRF checks, logout, and explicit tenant membership. The local authentication migration is applied. Provider responses are mocked in automated tests; session persistence and permission revocation are tested against real local PostgreSQL. The actual API also passed a session-mode startup check with dummy credentials and no outbound GitHub request.

Real GitHub sign-in succeeded on 2026-10-27 for `shreya-mishra325`: the callback created an active session and returned the browser to the public homepage. The account was explicitly granted membership in `dev-tenant`. The local environment is configured for session mode. The browser returned the expected GitHub identity and `dev-tenant` membership from `/auth/me`, and the authorized delivery-summary read succeeded. The browser logout check also passed: the CSRF-authenticated POST returned 204 and the next identity request returned 401. A primary-database audit confirmed zero active sessions for the account while its development-tenant membership remained intact. The public website has no sign-in UI yet.

## Local setup

1. Create an [OAuth app in GitHub](https://github.com/settings/applications/new), following [GitHub's registration instructions](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).
2. Use these development values:

| Setting | Value |
| --- | --- |
| Application name | Waybill Local |
| Homepage URL | `http://127.0.0.1:3001` |
| Authorization callback URL | `http://127.0.0.1:3000/auth/github/callback` |

3. Put the client ID and generated client secret in the ignored root `.env`. Do not put either value in frontend configuration or commit the secret.

```dotenv
API_AUTH_MODE=session
AUTH_API_ORIGIN=http://127.0.0.1:3000
AUTH_WEB_ORIGIN=http://127.0.0.1:3001
GITHUB_CLIENT_ID=<OAuth app client ID>
GITHUB_CLIENT_SECRET=<OAuth app client secret>
```

4. On a fresh checkout, apply migrations and refresh replica permissions before starting the API:

```bash
bunx prisma@5.22.0 migrate deploy --schema packages/shared/prisma/schema.prisma
bun run setup:replica
bun run dev:api
```

Start the website in another terminal with `bun run dev:web`. Use `127.0.0.1` consistently rather than mixing it with `localhost`; cookies are host-specific.

5. Open `http://127.0.0.1:3000/auth/github` in the browser. Complete GitHub authorization, then open `http://127.0.0.1:3000/auth/me`. This returns the signed-in identity and its authorized tenants. A first-time user has no tenant access.
6. Grant an existing tenant explicitly using the numeric `githubId` from `/auth/me` and the existing tenant UUID, for example the development `RECEIVER_TENANT_ID` recorded in `.env`:

```bash
bun run grant:tenant --github-id <numeric-github-id> --tenant <existing-tenant-uuid>
```

Remove access using the same command with `--revoke`. The user must already have signed in once. The command uses the configured primary database and has no HTTP equivalent. It never binds a tenant from a username, email, callback query, or public signup request.

## API contract

| Method and path | Behavior |
| --- | --- |
| `GET /auth/github` | Starts a five-minute browser-bound GitHub authorization attempt |
| `GET /auth/github/callback` | Consumes valid state once, checks GitHub identity, rotates the browser session, and redirects to the configured website origin |
| `GET /auth/me` | Returns public user identity, authorized tenant IDs/names, CSRF token, and absolute session expiry |
| `POST /auth/logout` | Requires the session, exact website `Origin`, and matching `X-CSRF-Token`; deletes the session and clears its cookie |

In session mode, existing delivery history, summary, dead-letter, archived-payload, replay, and ingestion endpoints require a valid session and membership in the requested tenant. Tenant reads remain replica-backed after authorization. `POST /events` checks the body's `tenantId`; tenant routes check the path parameter. Unknown membership returns 404. Missing, expired, or revoked sessions return 401. Invalid origin or CSRF returns 403. Authentication storage failures return 503 without bypassing access checks.

All cookie-authenticated writes require `Origin: <AUTH_WEB_ORIGIN>` and `X-CSRF-Token: <token from /auth/me>`. Browser requests use `credentials: "include"`. Only the configured website origin receives credentialed CORS responses. A valid preflight is not permission to perform the actual request; the write still passes session, CSRF, and tenant checks.

There are no personal access tokens or tenant API keys in this checkpoint. Existing unauthenticated cURL examples apply to development mode. Owned load, recovery, replay, and monitoring test APIs explicitly use development mode even when the main `.env` enables sign-in. Fairness tests that target an already-running API require that API to be started in development mode. These pipeline measurements exclude session-authentication overhead. Session mode requires browser-session credentials and CSRF headers for ingestion. Machine-to-machine credentials are separate work before exposing general integration clients.

## Session and authorization boundaries

GitHub identity uses the immutable numeric user ID. Login name changes update display metadata without changing membership. The OAuth request uses random state, a separate HttpOnly browser-binding cookie, and an S256 PKCE challenge. State is stored hashed and consumed atomically. The verifier remains in the short-lived login record because the server must send it during code exchange. GitHub calls are bounded to ten seconds each and reject redirects.

The GitHub access token is used only to fetch identity, then discarded. No repository or private-email scope is requested. GitHub token expiry or revocation does not automatically revoke an already-issued Waybill session. Waybill sessions have their own seven-day absolute expiry and explicit logout.

Session credentials contain 256 random bits and are stored only as SHA-256 hashes in PostgreSQL. Cookies are HttpOnly, SameSite=Lax, host-only, and Secure on HTTPS. HTTPS uses `__Host-` cookie names and `/` paths. The CSRF token is separate from the session credential and returned only through the authenticated, non-cacheable identity endpoint. Authentication responses and protected tenant responses are not cached. Request logging omits headers and query parameters so callback codes, state, cookies, CSRF values, and authorization headers are not recorded by the standard request logger.

Sessions and membership decisions use a bounded primary connection. They do not wait for replica catch-up. Authentication tables are physically replicated with PostgreSQL, but `waybill_reader` has no SELECT access to them. Delivery data remains available through its existing replica repositories. `setup:replica` reapplies those restrictions after general reader grants.

Expired attempts are removed on subsequent login starts; expired sessions are removed on subsequent successful sign-ins. Expired records are denied even before pruning. Tenant members currently have the same read, ingestion, and replay permissions; administrative roles, invitations, tenant creation, machine credentials, and multi-session management are not implemented.

## Development and deployment

`API_AUTH_MODE=development` preserves the existing local pipeline tests and disables API caller authorization. Startup prints a bypass warning, and GitHub endpoints are unavailable in that mode. An unset mode defaults to development outside production. Never expose that mode publicly.

With `NODE_ENV=production`, the default is session mode. Explicit development mode is rejected, missing OAuth settings prevent startup, and both configured origins must use HTTPS. Use a same-site frontend/API deployment, such as an API subdomain under the same site or a reverse proxy; SameSite cookies do not support an arbitrary cross-site frontend. No wildcard CORS origin or request-derived callback/return URL is accepted. `/health` and the separate internal metrics listener remain outside session authorization.

## Verification

```bash
bun run check:backend
bun run test:backend
RUN_AUTH_TESTS=1 bun test packages/api/src/repositories/auth.test.ts
```

The ordinary suite passed 111 tests, with five optional database tests skipped. The authentication persistence test passed separately against the local primary and replica, including one-time concurrent state consumption, reconnecting sessions, immediate tenant revocation, logout, expiry, stable identity after rename, and denied replica-reader access to authentication tables. HTTP tests cover all protected endpoint shapes, private cookie flags, fixed redirects, origin/CSRF rejection, and fail-closed storage errors. CI includes the new persistence test in its isolated database job; the new workflow changes have not run on GitHub yet.

Real provider authorization and the initial development-tenant grant are verified. Browser logout with the expected origin and CSRF token is verified. Invalid-origin and invalid-CSRF rejection remain covered by automated HTTP tests rather than a manual browser exercise. Authenticated ingestion/replay against live pipeline data, frontend sign-in/logout integration, production deployment, and machine-to-machine authentication remain unverified or unimplemented as described above.

References: [GitHub web authorization flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), and [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

### Real browser checkpoint: 2026-10-27

GitHub authorization, the callback redirect, `/auth/me`, explicit `dev-tenant` membership, and the replica-backed delivery summary were verified in Safari. Logout from the public website origin returned 204 with the session cookie and CSRF header; the subsequent `/auth/me` request returned 401. The server-side session was deleted and membership was preserved. Safari required the console verification code to run inside an async function rather than using top-level `await`.