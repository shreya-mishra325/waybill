# After Phase 9: Backend and system design notes

Phase 9 established the load and recovery baseline. The work after that added caller authentication, tenant authorization, API-key management, restricted access to system metrics, and release packaging checks. These notes cover those backend changes and the problems found while verifying them. Earlier scheduling, retry, replication-recovery, and load-test results stay in the [Phase 9 notes](./PHASE_9_NOTES.md).

## Authentication and tenant ownership are separate checks

Before caller authentication, a query filtered by `tenantId` could return the correct tenant's records without proving the caller belonged to that tenant. A UUID in a URL or request body is input, not a credential.

GitHub sign-in establishes identity. `tenant_memberships` establishes access to an existing tenant. A new account starts with no memberships. Access is granted explicitly through `bun run grant:tenant`, using the verified numeric GitHub ID and an existing tenant UUID. There is no automatic tenant assignment from a username, email address, or callback parameter.

The identity key is GitHub's numeric ID, stored as a string. The login name is display metadata and can change without creating a new identity or losing membership.

In session mode, the request path now has two different database responsibilities:

```text
Request with session cookie
  -> primary: resolve live session, expiry, and tenant membership
  -> authorize requested tenant
  -> replica: query delivery history, summary, or archive metadata

Authorized write
  -> primary: validate current permissions and commit the command
```

I kept security decisions on the primary because replica lag must not extend a revoked permission. A removed membership is checked on the next protected request. Delivery reads still use the existing replica repositories; adding authentication did not move those reads back to the primary.

Authentication tables physically reach the standby through replication, but the reader role is denied access to them. The same restriction applies to `api_keys`. Physical replication and application query permissions are different concerns. Replica setup reapplies these restrictions after its general grants.

Current tenant members have the same permissions. There are no owner/admin roles, invitations, or public tenant-creation flow.

Code: [authorization middleware](../packages/api/src/middleware/auth.ts), [session repository](../packages/api/src/repositories/auth.ts), [authentication setup](./AUTHENTICATION.md).

## OAuth needs protection around the callback

The implemented sign-in sequence is:

1. Generate random state, a browser-binding token, and a PKCE verifier.
2. Store hashes of state and the browser token, the verifier, and a five-minute expiry in PostgreSQL.
3. Set the separate HttpOnly browser-binding cookie and redirect to GitHub with an S256 challenge.
4. At callback, validate state and the binding cookie, then consume the matching login attempt once.
5. Exchange the code and verifier for a GitHub token, fetch the verified identity, and issue a new Waybill session.

State connects the callback to a login attempt. The browser token connects that attempt to the browser that started it. PKCE connects the authorization code to the verifier retained by the server. These checks have different jobs.

The concurrency detail mattered. Reading a login attempt is not enough to reserve it: two callbacks could read it before either finishes. The repository checks the conditional deletion count inside a transaction. Only the request that consumes one valid row proceeds to GitHub. Concurrent callbacks cannot both exchange the same attempt through this path.

The attempt is consumed before the provider call. If GitHub fails, the user starts another login attempt. Reusing partially completed state would make failure handling less predictable.

Both GitHub requests have ten-second deadlines and reject redirects. Callback and return destinations come from configured origins rather than request Host headers. The access token is used for identity lookup and discarded; Waybill does not retain it as its own session credential or request repository/private-email scopes.

Code: [OAuth service](../packages/api/src/services/auth.ts), [GitHub requests](../packages/api/src/services/github-auth.ts).

## Opaque sessions, expiry, and revocation

Waybill generates a 256-bit random session credential. The browser receives the credential; PostgreSQL stores its SHA-256 hash. The CSRF token is a separate value. Hashing the session credential means a database session row is not itself a usable cookie.

This is a server-side session design. Each protected request resolves the session and current membership instead of trusting a long-lived permission snapshot embedded in a token. Logout deletes the server record as well as clearing the cookie. A later `/auth/me` must return 401 even if an old cookie is submitted again.

Sign-in rotates the previous session from that browser. Sessions have a seven-day absolute expiry. Expired records are rejected even before later sign-ins prune them. Pruning is storage maintenance; it is not the security check.

GitHub credentials and Waybill sessions have separate lifecycles. GitHub token expiry or revocation does not automatically remove an already-issued Waybill session. Waybill's expiry and logout remain authoritative for that session.

| Condition | API behavior |
| --- | --- |
| Missing, expired, or revoked session | 401 |
| Invalid request origin or CSRF token | 403 |
| No membership in the requested tenant | 404 |
| Authentication storage unavailable | 503, without bypassing authorization |

Returning 404 for missing membership avoids distinguishing an inaccessible tenant from an unknown tenant in these endpoints. It does not replace the membership check.

The request logger omits headers and query parameters. Callback codes, OAuth state, cookies, bearer credentials, and CSRF values must not become ordinary request logs. Authentication and protected tenant responses use `Cache-Control: no-store`.

## Cookies, origins, CORS, and CSRF

The session cookie is host-only, HttpOnly, and SameSite=Lax. HTTPS adds Secure and the `__Host-` name prefix with path `/` and no Domain attribute.

A hostname and an origin are not the same thing. `127.0.0.1:3000` and `127.0.0.1:3001` share a cookie hostname but have different origins because the ports differ. `localhost` and `127.0.0.1` are different cookie hosts. Mixing them can make a valid session appear missing.

The API permits credentialed browser responses only for the configured website origin. Cookie-authenticated writes additionally require that exact Origin and the session's `X-CSRF-Token`. CORS controls browser access to responses; it does not prove that a request is authorized. Passing preflight does not skip session, membership, or CSRF validation.

A concrete integration failure appeared with replay. Its request already used `Idempotency-Key`, but the CORS allow-header list contained only `Content-Type` and `X-CSRF-Token`. The browser could reject preflight before the replay service ran. The correction was to allow that existing header. It did not require another replay endpoint, a wildcard origin, or weaker CSRF checks.

OAuth state protects the login exchange. The CSRF token protects later cookie-authenticated writes. One cannot substitute for the other.

## API keys are bounded capabilities

A backend integration should not need a person's browser cookie just to publish events. The application key grants one capability, `events:write`, for one tenant.

```text
wb_<key UUID>.<256-bit random secret>
```

The UUID identifies the stored record. Verification hashes the complete credential and compares fixed-length hashes with `timingSafeEqual`. The database stores the hash and metadata, never a recoverable issued secret.

Creation accepts a trimmed name of 1-80 characters and an optional integer expiry of 1-365 days, defaulting to 90. The scope is fixed by the server; unknown fields and custom scopes are rejected. The plaintext credential is returned only by successful creation. Listing and revocation omit both the credential and its hash.

This affects recovery from a lost response. If key creation commits but its response is lost, listing cannot reveal the secret. The safe procedure is to identify and revoke the unwanted key, then create a replacement. Repeatedly pressing create is not an idempotent key-creation protocol.

| Operation | Accepted credential |
| --- | --- |
| `POST /events` | Tenant-scoped API key, or authorized session with CSRF |
| Delivery history and summaries | Authorized session |
| Archived payload retrieval and replay | Authorized session |
| Key creation, listing, and revocation | Authorized session; writes also require CSRF |

If an Authorization header is supplied, an invalid bearer credential is rejected even when a valid cookie is present. Falling back to the cookie would hide an integration's broken key and make its actual authority ambiguous.

Keys are foreign-keyed to the creator's tenant membership. Removing that membership deletes those keys, so they cannot keep ingesting after the creator loses access. Members can currently revoke each other's tenant keys. Explicit revocation preserves its original timestamp when retried; expiry and revocation are checked against primary state.

Keys remain bearer credentials. Hashing stored values does not protect a plaintext key copied from the caller's environment. Transport uses HTTPS in production, and credentials belong in headers rather than URLs.

Code: [key service](../packages/api/src/services/api-keys.ts), [key repository](../packages/api/src/repositories/api-keys.ts), [membership constraint](../packages/shared/prisma/migrations/20261028010000_api_keys/migration.sql).

## Verifying the authenticated pipeline

Provider verification, authorization tests, and delivery verification answer different questions.

The real GitHub login verified authorization, callback handling, session issuance, and the identity returned by `/auth/me`. Automated provider fixtures exercised invalid callbacks, provider failures, and concurrency. Database tests checked persistence, expiry, membership removal, hashed key storage, and denied reader access.

The authenticated pipeline runner used temporary tenants, a test session, and keys against the real local API, publisher, worker, signed receiver, and development queue. It did not perform GitHub login or borrow browser cookies. That makes it useful for repeatable backend checks, while the provider round trip remains separately verified.

The recorded authenticated run had three successful events and one intentional dead letter. Session and key ingestion returned 201 and reached durable success. A cross-tenant key returned 404, an invalid bearer with a valid cookie returned 401, and a missing CSRF token returned 403. Denied requests created no event.

Five concurrent authenticated replay requests returned one new event and one replay audit command. The original failure remained dead-lettered, and the replay succeeded. The same request key returned the same command identity afterward. This exercised the existing outbox and replay invariants through authorization rather than replacing those paths.

The fixture used three delivery attempts for its intentional failure. That is not a change to the normal retry default. This small correctness run also says nothing about authentication overhead at saturation: the earlier Phase 9 load profiles used development caller-authentication bypass.

Evidence: [authenticated pipeline checkpoint](./AUTHENTICATION.md#authenticated-pipeline-checkpoint-2026-10-28). Detailed local reports remain under ignored `logs/auth-flow-*` paths.

## Diagnosing three DOWN monitoring targets

The monitoring containers were healthy, but all three scrape targets returned connection refused. That did not establish missing instrumentation.

The recorded diagnosis was:

| Target | Actual finding |
| --- | --- |
| API, port 9100 | API `/health` returned 200, but `METRICS_ENABLED=false` left the separate metrics listener disabled |
| Publisher, port 9101 | No publisher process or metrics listener was running |
| Worker, port 9102 | No worker process or metrics listener was running |

Prometheus and Grafana running successfully does not start the services they observe. The metrics listener is also separate from the API's application port. A working `/health` response does not imply that port 9100 is listening or that the pipeline is ready.

The correction reused the existing listeners and ports. The services were started with a process-local `METRICS_ENABLED=true` override; the metrics setting and secrets in `.env` were not overwritten. The endpoint returned Prometheus text format on each port, all three targets became UP, and Grafana's existing Prometheus datasource passed its health query. Anonymous Grafana access remained 401.

There was one unpublished event before restart. Resuming the publisher and worker could change that real event's state, so receiver availability and pending work had to be checked first. The restoration delivered that existing event without generating new test events. Starting consumers is an operational action, not a read-only diagnostic.

The metrics listeners remain restricted to loopback. The local Prometheus configuration uses `host.docker.internal` to reach them through Docker Desktop. This was verified locally; it is not a portable production service-discovery configuration.

My diagnostic order is now: read the scrape error, check the expected process, check the listener and effective configuration, request the endpoint, then check container reachability and the query result. Changing instrumentation before those checks would have addressed the wrong problem here.

Local evidence: `logs/frontend-audit-monitoring-diagnostics.json`, `logs/monitoring-restore-preflight.json`, and `logs/monitoring-restore-verification.json`. These are historical verification records, not a statement that today's processes are still running.

## Missing metrics are not zero measurements

Some metric label combinations exist only after an observation. A successful scrape can therefore contain a metric declaration without samples for a particular outcome.

| Result | Interpretation |
| --- | --- |
| Fresh finite value of zero | An actual zero measurement |
| No matching series | No series observed for that query/label combination |
| Histogram window with no observations | No usable latency percentile in that window |
| Old scrape or backlog timestamp | Stale data |
| Failed scrape or failed source sample | Source unavailable |
| Failed query, malformed result, or oversized body | Query unavailable |
| NaN or infinity | Not a valid finite measurement; idle histograms are classified separately |

The restoration had one real successful attempt and its duration observation, but no retry observations. A recent percentile window can become idle even though the process's cumulative histogram count remains one. Filling all absent results with zero would falsely report perfect latency or a healthy empty queue.

Webhook call duration measures the HTTP call, not time from ingestion through outbox, queueing, retries, and receipt. Histogram quantiles come from aggregated bucket rates; they are not averages of per-process p95 values. Values stay in seconds.

Source checks use scrape state and timestamp freshness. Backlog additionally requires successful sampling and a sample age below 90 seconds. The server uses a 45-second scrape freshness boundary. A source can be reachable while its last backlog sample is unusable.

Process counters reset on restart. Durable delivery outcomes still come from PostgreSQL. Metric observations must not be added across restarts as if they were a permanent event ledger. Existing fixed labels also mean these metrics are system-wide, not tenant-specific analytics.

## Tenant authorization does not grant operator access

Tenant membership grants access to that tenant's data. System metrics describe shared API, publisher, worker, queue, and outbox behavior. Exposing those metrics to every signed-in tenant would cross that boundary.

Operator authorization uses the server-only `WAYBILL_OPERATOR_GITHUB_IDS` allowlist. The server obtains the verified numeric ID through `/auth/me`; it does not accept an operator ID from request input or use the mutable login name. Missing, empty, or malformed configuration grants nobody access. A malformed entry invalidates the configuration rather than leaving a partially valid list.

For a correctly configured request topology, the monitoring request order is:

```text
Validate configured topology and request host/origin
  -> extract the single valid session cookie
  -> existing /auth/me verifies the live session
  -> compare its GitHub ID with the operator allowlist
  -> validate the selected range
  -> reuse an authorized snapshot or issue fixed Prometheus queries
```

Signed-out requests return 401. Signed-in non-operators return 403 before any Prometheus request. If session verification is unavailable, the integration returns 503 rather than assuming the caller is still authorized.

The allowlist is process configuration, not a database role or tenant membership. Local verification used a temporary process override. Editing an environment file alone does not update an already-running process.

Code: [server-side monitoring handler](../packages/web/src/server/observability.ts). Its location does not change the security boundary: session validation and private monitoring requests execute on the server.

## Cache measurements without caching permission

Monitoring snapshots can be shared between authorized operators because the measurements are system-wide. They are cached for at most ten seconds, shortened when a source freshness boundary would expire sooner.

Every request still checks `/auth/me` and operator authorization before reading that cache. The security test first fills the cache as an operator, then removes the grant and confirms the next request returns 403 without another Prometheus query. A cached successful response must not preserve revoked permission.

The internal snapshot cache is separate from HTTP caching. Success and error responses use `Cache-Control: private, no-store` and `Vary: Cookie`, with no CORS grant for arbitrary origins. Authentication lookups and upstream fetches also use `cache: no-store`. This keeps a browser cache, shared proxy, or CDN from becoming an alternate authorization path.

Only the session cookie is forwarded to the configured authentication API. Cookies, CSRF values, and bearer credentials are not forwarded to Prometheus. Public error responses omit internal URLs, credentials, and upstream response bodies.

## Fixed queries and bounded work

The monitoring endpoint accepts only a range selector. It does not accept PromQL, a URL, or a datasource name. Queries and upstream paths are server-controlled. The configured Prometheus origin rejects credentials, path/query fragments, and unsupported public hostnames; actual private connectivity still depends on deployment networking.

| Bound | Current implementation |
| --- | --- |
| Ranges and fixed steps | 1h / 15 seconds, 6h / 60 seconds, 24h / 120 seconds |
| Session verification | 3-second deadline; 64 KiB body limit |
| Prometheus request | 5-second deadline; 512 KiB body limit |
| Snapshot collection | 8-second deadline, separate from session verification |
| Returned data | At most 8 series and 721 points per upstream series; 1 MiB normalized response |
| Parallel queries | 3 per snapshot |
| In-flight snapshots | At most 3 per handler instance; identical requests coalesce |

The aggregate limit is up to nine simultaneous upstream queries per handler instance, not three across all requests or deployments. Multiple application instances multiply that capacity. This is bounded local concurrency, not a distributed rate limiter.

The body limit counts downloaded bytes even if Content-Length is absent or misleading. Deadline signals apply during body reading as well as the initial request. Malformed JSON, duplicate or oversized series, invalid timestamps, partial query warnings, and non-finite measurements do not become valid observations.

Holding a fixed time range is not enough to bound cost if query text, series cardinality, response bytes, or concurrency remain unbounded. These limits cover different resource costs.

## Host-only cookies constrain deployment topology

The monitoring bridge needs the existing session cookie to reach the server handling the request. Its supported topology requires `AUTH_API_ORIGIN` and `AUTH_WEB_ORIGIN` to share a hostname and scheme. Development can use different ports on `127.0.0.1`; production requires HTTPS.

A same-site API subdomain can work for ordinary browser-to-API authentication under the configured cookie/CORS rules, but the API's host-only cookie will not arrive at a server on another hostname. Those are different integration paths. The current monitoring bridge deliberately refuses the separate-host topology.

The supported production direction is a shared HTTPS hostname with explicit reverse-proxy routing to the existing API and application processes. The proxy must preserve the expected public Host. Authentication and Prometheus destinations are fixed server configuration; neither Host nor forwarded headers select upstream destinations. A forged Host is rejected, while forwarded headers are ignored for that decision.

If separate hostnames are required, authorization belongs in an API-owned monitoring integration or another separately reviewed design. Expanding the cookie Domain, trusting client identity, or accepting request-selected URLs is not a configuration fix.

## Packaging is part of reproducibility

The Dockerfiles referenced `bun.lockb*`, while the repository uses `bun.lock`. An image built without the actual lockfile could resolve a different dependency set from the checkout being tested.

Both backend images now pin Bun 1.4.3 and use `bun install --frozen-lockfile`. Every workspace manifest is copied before installation so Bun can resolve the lockfile's workspace graph. Installation is filtered to the relevant backend package and shared package. Dependency layers come before source copies, so source edits do not require reinstalling unchanged dependencies.

Prisma needs a generated client and a runtime-compatible engine inside the image. Copying a laptop's `node_modules` would not establish that. The image installs its own dependencies, includes Alpine's OpenSSL runtime, and runs the lockfile-installed Prisma CLI directly:

```bash
bun packages/shared/node_modules/prisma/build/index.js generate --schema packages/shared/prisma/schema.prisma
```

The first build used the root generation command, which invoked `bunx` and resolved the CLI again. Calling the already-installed CLI removed that extra resolution step. The final image retained the original lockfile contents.

The API and worker images built for Linux ARM64. Network-disabled checks loaded the generated Prisma engine; attempting a connection to an intentionally unreachable local address produced the expected database-unreachable error. That proves engine loading, not successful database connectivity. The API also served `/health` inside its isolated container. Worker and publisher imports loaded, and their real entry points reached the expected missing-queue configuration check.

The publisher is a separate process using `src/outbox-poller.ts` from the worker image. Building the worker image does not start a publisher automatically. These checks did not consume messages, publish events, or use deployment credentials.

Code: [API Dockerfile](../packages/api/Dockerfile), [worker Dockerfile](../packages/worker/Dockerfile).

## Git exclusions, Docker context, and test discovery are independent

`.gitignore` protects against accidentally tracking local files. Docker does not use it to filter the build context. Both current image builds use the repository root, so one root `.dockerignore` excludes environment files, keys, Git metadata, local dependencies, logs, browser profiles, test artifacts, and build output while retaining source, manifests, migrations, and `bun.lock`.

The context export and image-layer inspection verified that local environment and QA artifacts were absent. Nothing sensitive should enter an earlier image layer even if a later command removes it.

The context inspection exposed another tooling boundary. Exporting a source copy under `logs/packaging-context` also copied test files. Plain `bun test` discovered them despite the directory being ignored by Git. The copy deliberately had no dependencies, so those duplicate tests failed with missing packages such as `@waybill/shared` and `@prisma/client`. Installing dependencies into that inspection copy would have treated the symptom.

`bunfig.toml` now limits test discovery to `./packages`. The next run found 41 real test files rather than 82 real-plus-copied files. All 181 ordinary tests passed; six opt-in database suites were skipped. Enabling the two authentication database suites separately passed both, without discovering their copied versions.

The three file-selection mechanisms need separate configuration: what Git tracks, what Docker receives, and what the test runner executes.

## Configuration and verification limits

`INGESTION_RATE_LIMIT_CAPACITY=10s` in `.env.example` was invalid for a field read with `Number(...)`. It is now `10`, matching the ingestion and shared token-bucket defaults. This capacity is a token count, not a duration. The template check explicitly verifies finite positive numbers and exercises the existing rate-limit, authentication, metrics, URL, and Prisma configuration. The local `.env` was not rewritten.

`API_AUTH_MODE=development` remains a deliberate authorization bypass for owned local test processes. Production configuration defaults to session mode, rejects an explicit development bypass, requires OAuth credentials, and requires HTTPS origins. A pipeline test that bypasses caller authentication must not be presented as a session-mode performance result.

Correcting the example is not the same as adding comprehensive runtime validation to every numeric environment variable. JavaScript can produce NaN for malformed numeric strings, and a check that only compares a value with zero does not reject NaN. That distinction matters when reviewing other configuration paths.

CI separates ordinary checks from the database integration job. The latter applies migrations to a fresh primary, starts a physical replica, and runs guarded persistence tests sequentially without competing publishers or consumers. Mocked SQS sends and controlled database fixtures do not establish live AWS permissions or production capacity. Local passing checks also do not prove an unpushed workflow passed on GitHub.

The remaining backend deployment work includes production process definitions and supervision, readiness and shutdown verification, managed replication, backups, IAM, HTTPS routing, and private metrics connectivity. The current loopback-only listeners and Docker Desktop host discovery need a deliberate production networking plan. A successful local image build is one checkpoint, not a deployed or production-ready system.

## Evidence to revisit

- [Authentication setup and recorded backend checks](./AUTHENTICATION.md)
- [Authentication and key security tests](../packages/api/src/services/auth.test.ts)
- [Key authorization tests](../packages/api/src/services/api-keys.test.ts)
- [Session persistence and revocation tests](../packages/api/src/repositories/auth.test.ts)
- [Key persistence and membership tests](../packages/api/src/repositories/api-keys.test.ts)
- [Monitoring authorization, cache, host, deadline, and size tests](../packages/web/tests/monitoring-security.test.ts)
- [Metrics listener configuration](../packages/shared/src/metrics-server.ts)
- [CI workflow](../.github/workflows/backend.yml), [Docker context exclusions](../.dockerignore), and [test discovery configuration](../bunfig.toml)

Detailed verification reports remain local and ignored. The source links and recorded results above preserve the reasoning without publishing runtime artifacts.