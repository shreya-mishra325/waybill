# GitHub sign-in and tenant access

## Current status

The API implements GitHub sign-in, server-side sessions, CSRF checks, logout, explicit tenant membership, and ingestion-only API keys. The local authentication migration is applied. Provider responses are mocked in automated tests; session persistence and permission revocation are tested against real local PostgreSQL. The actual API also passed a session-mode startup check with dummy credentials and no outbound GitHub request.

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

In session mode, delivery history, summary, dead-letter, archived-payload, and replay endpoints require a valid browser session and membership in the requested tenant. Ingestion accepts either that session with CSRF protection or a valid API key for the body's tenant. Tenant reads remain replica-backed after authorization. `POST /events` checks the body's `tenantId`; tenant routes check the path parameter. Unknown membership returns 404. Missing, expired, or revoked sessions return 401. Invalid origin or CSRF returns 403. Authentication storage failures return 503 without bypassing access checks.

All cookie-authenticated writes require `Origin: <AUTH_WEB_ORIGIN>` and `X-CSRF-Token: <token from /auth/me>`. Browser requests use `credentials: "include"`. Only the configured website origin receives credentialed CORS responses. A valid preflight is not permission to perform the actual request; the write still passes session, CSRF, and tenant checks.

Existing unauthenticated public-site examples apply to development mode. Owned load, recovery, replay, and monitoring test APIs explicitly use development mode even when the main `.env` enables sign-in. Fairness tests that target an already-running API require that API to be started in development mode. Their measurements exclude authentication overhead. The authenticated-flow runner below deliberately uses session mode.

## Application API keys

An API key grants only `events:write` for one tenant. It can authorize `POST /events` with an `Authorization: Bearer <key>` header. It does not grant delivery-history, payload, replay, or key-management access. Those operations still use the signed-in user's session and tenant membership. If an Authorization header is supplied, invalid credentials are rejected without falling back to a valid cookie.

| Method and path | Session requirement and response |
| --- | --- |
| `POST /tenants/:tenantId/api-keys` | Membership, trusted Origin, and CSRF token; returns 201 with the new secret once |
| `GET /tenants/:tenantId/api-keys` | Membership; returns metadata with a default limit of 20, maximum 100, and optional UUID `cursor` |
| `POST /tenants/:tenantId/api-keys/:keyId/revoke` | Membership, trusted Origin, and CSRF token; returns metadata with `revokedAt`, preserving the original timestamp on retries |

Creation accepts JSON such as `{"name":"orders-service","expiresInDays":90}`. Names must contain 1 to 80 characters after trimming. Expiry defaults to 90 days and accepts integers from 1 through 365. Unknown input fields, including caller-selected scopes, are rejected. Responses include `scope: "events:write"`. List responses have `items` and `nextCursor`; list and revoke responses omit both the secret and its hash.

Keys have the form `wb_<key UUID>.<random secret>`. The secret contains 256 random bits. Only the SHA-256 hash of the complete credential is stored; verification uses constant-time hash comparison. Authentication and key metadata use bounded primary connections. The replica reader is denied access to `api_keys`, both by the migration and by subsequent replica setup.

Tenant members currently share the same management permissions, including revoking another member's key. The database ties each key to its creator's membership. Removing that membership deletes the associated key records, so a removed member's credentials stop working. Explicitly revoked and expired keys remain visible as metadata until membership or tenant deletion. A copied key remains a bearer credential until expiry, revocation, or membership removal.

Store the returned secret in the calling application's secret configuration. It cannot be recovered from Waybill later. If creation's response is lost, list the metadata, revoke the unwanted key, and create a replacement. To rotate, create a new key, update the caller, then revoke the old one. No new server environment variable is required because the verifier stores hashes in PostgreSQL.

```bash
curl --fail-with-body --max-time 10 http://127.0.0.1:3000/events \
  --header "Authorization: Bearer $WAYBILL_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{"tenantId":"<existing-tenant-uuid>","type":"order.shipped","payload":{"orderId":"order_123"}}'
```

`WAYBILL_API_KEY` is a secret configured in the calling application's environment, not a committed value or a required field in Waybill's root `.env.example`. Production uses HTTPS. Keys belong in the Authorization header, not URLs. Existing per-tenant ingestion limits still apply through the normal ingestion service. Browser CORS remains restricted to the configured website origin and does not advertise Authorization for cross-origin browser calls; API keys are for server-side integrations. See [OWASP REST security guidance](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).


## Session and authorization boundaries

GitHub identity uses the immutable numeric user ID. Login name changes update display metadata without changing membership. The OAuth request uses random state, a separate HttpOnly browser-binding cookie, and an S256 PKCE challenge. State is stored hashed and consumed atomically. The verifier remains in the short-lived login record because the server must send it during code exchange. GitHub calls are bounded to ten seconds each and reject redirects.

The GitHub access token is used only to fetch identity, then discarded. No repository or private-email scope is requested. GitHub token expiry or revocation does not automatically revoke an already-issued Waybill session. Waybill sessions have their own seven-day absolute expiry and explicit logout.

Session credentials contain 256 random bits and are stored only as SHA-256 hashes in PostgreSQL. Cookies are HttpOnly, SameSite=Lax, host-only, and Secure on HTTPS. HTTPS uses `__Host-` cookie names and `/` paths. The CSRF token is separate from the session credential and returned only through the authenticated, non-cacheable identity endpoint. Authentication responses and protected tenant responses are not cached. Request logging omits headers and query parameters so callback codes, state, cookies, CSRF values, and authorization headers are not recorded by the standard request logger.

Sessions and membership decisions use a bounded primary connection. They do not wait for replica catch-up. Authentication tables are physically replicated with PostgreSQL, but `waybill_reader` has no SELECT access to them. Delivery data remains available through its existing replica repositories. `setup:replica` reapplies those restrictions after general reader grants.

Expired attempts are removed on subsequent login starts; expired sessions are removed on subsequent successful sign-ins. Expired records are denied even before pruning. Tenant members currently have the same read, ingestion, and replay permissions; administrative roles, invitations, tenant creation, and multi-session management are not implemented.

## Development and deployment

`API_AUTH_MODE=development` preserves the existing local pipeline tests and disables API caller authorization. Startup prints a bypass warning, and GitHub endpoints are unavailable in that mode. An unset mode defaults to development outside production. Never expose that mode publicly.

With `NODE_ENV=production`, the default is session mode. Explicit development mode is rejected, missing OAuth settings prevent startup, and both configured origins must use HTTPS. Use a same-site frontend/API deployment, such as an API subdomain under the same site or a reverse proxy; SameSite cookies do not support an arbitrary cross-site frontend. No wildcard CORS origin or request-derived callback/return URL is accepted. `/health` and the separate internal metrics listener remain outside session authorization.

## Verification

```bash
bun run check:backend
bun run test:backend
RUN_AUTH_TESTS=1 bun test packages/api/src/repositories/auth.test.ts packages/api/src/repositories/api-keys.test.ts
bun run test:auth:flow
```

The ordinary suite passed 114 tests, with six optional database tests skipped. Both authentication database suites passed separately. The authentication persistence test passed separately against the local primary and replica, including one-time concurrent state consumption, reconnecting sessions, immediate tenant revocation, logout, expiry, stable identity after rename, and denied replica-reader access to authentication tables. HTTP tests cover all protected endpoint shapes, private cookie flags, fixed redirects, origin/CSRF rejection, and fail-closed storage errors. CI includes session and API-key persistence tests in its isolated database job. The latest uncommitted workflow changes still need their own GitHub run.

Real provider authorization and the initial development-tenant grant are verified. Browser logout with the expected origin and CSRF token is verified. Invalid-origin and invalid-CSRF rejection remain covered by automated HTTP tests rather than a manual browser exercise. Authenticated ingestion and replay through the real pipeline are now verified with a temporary local session and keys, as recorded below. Frontend sign-in/logout and key-management integration, plus production deployment, remain separate work.

References: [GitHub web authorization flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), and [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

### Real browser checkpoint: 2026-10-27

GitHub authorization, the callback redirect, `/auth/me`, explicit `dev-tenant` membership, and the replica-backed delivery summary were verified in Safari. Logout from the public website origin returned 204 with the session cookie and CSRF header; the subsequent `/auth/me` request returned 401. The server-side session was deleted and membership was preserved. Safari required the console verification code to run inside an async function rather than using top-level `await`.
## Authenticated pipeline checkpoint: 2026-10-28

`bun run test:auth:flow` passed with run ID `e8e76f36-5025-4253-a4e5-4092a04d89d6`. The manifest and result are under ignored `logs/auth-flow-<run-id>*` paths. The runner uses a dedicated API on port 3113, temporary tenants and a locally-created session, and its own publisher, worker, and signed receiver. It does not read browser cookies or perform a new GitHub authorization. Browser/provider verification remains the separate 2026-10-27 checkpoint above.

| Check | Result |
| --- | --- |
| API-key and session ingestion | Both returned 201, delivered signed payloads, and reached durable success |
| Cross-tenant key / invalid bearer with valid cookie / missing CSRF | 404 / 401 / 403; no denied request created an event |
| Key disclosure | Creation returned the secret; listing omitted the secret and hash |
| Key capabilities | Delivery reads, replay, and key management rejected bearer-only requests |
| Revoked and expired credentials | Rejected with 401 |
| Exhausted fixture | Three failed calls, one preserved dead-letter outcome |
| Authenticated replay | Five concurrent requests returned one event and one audit command; replay delivered successfully |
| Retry of the completed replay command | Returned the same event identity |
| Replica summary | Authorized session read returned all four owned deliveries |
| Membership removal | Disabled its keys and denied subsequent tenant reads |
| Logout | Returned 204; subsequent identity request returned 401 |
| Final outcomes | Three successful events and one intentional dead letter, zero invalid signatures/unexpected payloads |
| Queue and cleanup | Queue/outbox drained; owned processes, credentials, tenants, and test records removed |

The two repeated calls beyond first receipt were the expected retry attempts for the intentionally failed event. No successful event required a repeated receiver call in this run. The exhausted event used a pointer to an existing development S3 object. The runner did not upload or delete S3 fixtures, purge the queue, or alter the real user's membership. Failed runs after publication preserve owned event work for diagnosis while deleting their temporary user and credentials. All HTTP, AWS, database, and process waits are bounded.

The API-key migration is applied locally and matches the Prisma model. Security tests additionally verify wrong secrets, expiry bounds, pagination, fail-closed storage errors, stable revocation timestamps, hashed persistence, membership-cascade invalidation, and denied replica-reader access. No production-capacity or authentication-overhead claim is made from this four-event check.
