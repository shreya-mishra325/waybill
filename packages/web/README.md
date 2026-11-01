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
