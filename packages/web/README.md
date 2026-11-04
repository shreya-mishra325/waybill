# Waybill web

Next.js App Router frontend for the public website, documentation, and authenticated application. The Express/Bun API remains a separate service. This package does not access the database or duplicate backend logic.

## Local development

From the repository root, with dependencies installed:

```bash
bun run dev:api
```

In a second terminal:

```bash
bun run dev:web
```

Open `http://127.0.0.1:3001` for the public website, `/docs` for documentation, or `/app` to sign in and select a workspace. The API defaults to `http://127.0.0.1:3000` during frontend development.

Authenticated pages require the existing session-auth configuration, GitHub OAuth credentials, database services, and tenant membership. See [Authentication](../../docs/AUTHENTICATION.md). The server reads `AUTH_API_ORIGIN`; production requires this variable at runtime. It must match the API origin and the backend must allow the frontend origin. Do not expose OAuth secrets through frontend environment variables.

## Authenticated application

`/app` handles sign-in and workspace selection. `/app/<tenantId>` displays the Overview using the existing tenant summary and delivery-history endpoints. Workspace selection is checked against the current session memberships. Only the selected workspace UUID is stored locally; credentials and CSRF tokens are not persisted there.

Overview includes status totals, the latest five deliveries, delivery outcomes, and loading, empty, expired-session, and request-error states. Its success rate uses completed deliveries, matching the backend contract. Future page links and delivery-detail actions remain disabled until those pages are implemented.

Shared application components live in `src/components/dashboard`, API response validation and formatting in `src/lib/dashboard-*`, and scoped styles in `src/app/app/dashboard.css`.

## Checks and production

```bash
bun run check:web
bun test packages/web/tests
bun run build:web
bun run --cwd packages/web start
```

Provide `AUTH_API_ORIGIN` to the production server. Authenticated routes render at request time; public pages and documentation retain their existing rendering behavior.

## Typography and motion

Rosarivo is used for the public hero’s “Webhooks” line, Rufina for serif headings, and DM Sans for interface text. Fonts are self-hosted through `next/font`. The public network animation and authenticated artwork respect reduced-motion preferences. Add `?motion=off` to disable the public network animation explicitly.

## Operator monitoring

The Observability endpoint is `GET /api/observability?range=1h`, with `1h`, `6h`, and `24h` supported. It verifies the existing session through `/auth/me` before every request, including cached snapshots. Configure the web server with `WAYBILL_OPERATOR_GITHUB_IDS`, a comma-separated list of explicitly authorized numeric GitHub user IDs, and `WAYBILL_PROMETHEUS_ORIGIN`, the private Prometheus origin. Neither variable uses the `NEXT_PUBLIC_` prefix. Missing or malformed operator configuration denies access; tenant membership grants no monitoring permission.

Set `AUTH_API_ORIGIN` and `AUTH_WEB_ORIGIN` explicitly in the web process. Both must share their hostname and scheme so the existing host-only session cookie reaches Next.js. Local development uses `http://127.0.0.1:3000` and `http://127.0.0.1:3001`. Production requires HTTPS and the same hostname, normally with a reverse proxy routing to the existing API and web processes. A separate API hostname requires an API-owned integration instead; the current endpoint fails closed in that topology. Cookies and tenant authorization are unchanged.

Queries use fixed expressions, five-second request deadlines, an eight-second collection deadline, three concurrent upstream requests, a 512 KiB upstream body limit, and a 1 MiB normalized response limit. Steps are 15, 60, and 120 seconds, bounded to 721 points per series and eight upstream series. Snapshots may be reused for ten seconds, shortened when source freshness expires; authorization is never cached. The page refreshes every 30 seconds and cancels requests when the workspace or range changes.

Duration values remain seconds. Missing series, invalid values, idle histogram windows, failed queries, unhealthy targets, and stale samples remain distinct from real zeroes. Curves break across missing samples. Queue/outbox values additionally require the existing successful-sampling and 90-second freshness gates. Monitoring is system-wide; Grafana retains its separate operator login.
