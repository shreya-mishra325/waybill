# Waybill dashboard design

Design specification for the Phase 7 tenant dashboard. No frontend implementation exists yet.

## Purpose

The dashboard should answer four questions: what happened to a delivery, why it failed, what payload was saved, and whether its replay succeeded.

The visual direction is a compact delivery operations console. Graphite surfaces, amber actions, clear status labels, and monospace identifiers fit the dispatch workflow. Tables and error details take priority over decorative charts.

## Layout

Desktop uses a 208 px sidebar, a 64 px workspace header, and a flexible content area. Content has 24 px padding and a maximum width of 1440 px. The header contains the tenant switcher, last successful refresh time, and a refresh button.

```text
+------------------+------------------------------------------------------------+
| WAYBILL          | Tenant: Development          Updated 12:41:08   [Refresh]   |
|                  +------------------------------------------------------------+
| Overview         | Overview                                                   |
| Deliveries       | Delivery outcomes for the selected tenant                  |
| Dead letters     |                                                            |
|                  | Total     Delivered     Waiting     Dead letters    Rate   |
|                  | 1,248     1,190         46          12              99.00% |
|                  |                                                            |
|                  | Status distribution                                        |
|                  | [ Delivered | Waiting | Dead letters ]                     |
|                  |                                                            |
|                  | Recent deliveries                              [View all] |
|                  | Event          Type           Status       Attempts   Time |
|                  | 7c9e...        order.shipped  Delivered    1          12:40 |
|                  | a182...        order.shipped  Retry due    3          12:39 |
+------------------+------------------------------------------------------------+
```

Numbers in this wireframe are illustrative. The implemented interface must use actual API responses, including empty states, rather than prefilled sample traffic.

A selected row opens a detail drawer on the right, 440-560 px wide. The table stays visible behind it. At widths below 1024 px, navigation becomes a compact menu. Below 768 px, the detail view fills the content area and summary cards wrap into two columns. Tables may scroll horizontally; column headings and identifiers must remain readable.

## Visual tokens

| Token | Value | Use |
| --- | --- | --- |
| Canvas | `#111315` | Main background |
| Surface | `#191C1F` | Sidebar and tables |
| Raised surface | `#22262A` | Dialogs and selected rows |
| Border | `#343A40` | Section and row separators |
| Primary text | `#F2F0EA` | Titles and important values |
| Secondary text | `#ADB5BD` | Labels and supporting text |
| Accent | `#F2B86B` | Main actions and active navigation |
| Success | `#8ED5AD` | Delivered state |
| Warning | `#F2CB7B` | Retry state |
| Danger | `#FF9B9B` | Dead-letter state and errors |
| Information | `#9BC7F5` | In-flight state |

Use system sans-serif fonts for UI text and a system monospace stack for IDs, timestamps, URLs, and JSON. Body text is 14 px, page titles 24 px, and summary values 28 px. Controls are at least 36 px high; compact table rows are about 48 px high. Use 6-8 px corner radii, restrained shadows on overlays, and no gradients or glass effects.

Status badges combine readable text with a small shape or icon. Colour is supplementary. Check contrast for rendered text, badges, and focus indicators before implementation is accepted.

## Screens

### Overview

Five summary cards show total deliveries, delivered, waiting, dead letters, and terminal success rate. Waiting is `PENDING + IN_FLIGHT + FAILED`. The rate is `SUCCEEDED / (SUCCEEDED + DEAD_LETTERED)`; show "No completed deliveries" when the API returns null.

These are all retained delivery records for the tenant, not today's traffic. A simple status-distribution bar can use the same counts. Do not add trends, p95 latency, throughput charts, or time-range selectors without supporting APIs. Prometheus/Grafana service panels belong to Phase 8.

Below the cards, show the ten most recent deliveries with a link to the full list. Summary and list requests are independent, so a failed section can retry without removing the rest of the page.

### Deliveries

The toolbar contains a status filter, page-size selector (20, 50, 100), refresh, and next/previous controls. No global search or date filter is shown in the first version.

| Column | Content |
| --- | --- |
| Event | Short event ID with copy control; full ID in details |
| Type | Event type |
| Status | Label and badge |
| Attempts | Current attempt count |
| Destination | Shortened host/path; full URL in details |
| Created | Relative time, with an absolute timestamp available |

Sort is newest first, using the server's timestamp and ID ordering. Keep a client-side cursor stack for Previous; the API only supplies Next. Changing tenant, status, or page size resets pagination.

The drawer shows delivery ID, event ID, type, destination, status, attempt count, created time, last attempt, next attempt, and last error. Display zero attempts as "Not attempted" where useful. There is no attempt timeline or stored HTTP response history in the current model.

| Stored status | Display label |
| --- | --- |
| `PENDING` | Pending |
| `IN_FLIGHT` | Delivering |
| `SUCCEEDED` | Delivered |
| `FAILED` with a future retry time | Retry scheduled |
| `FAILED` without a future retry time | Awaiting retry |
| `DEAD_LETTERED` | Dead letter |

The delivery endpoint does not return a dead-letter record ID. A dead-lettered delivery can offer a link to the Dead letters screen, but must not fabricate a direct payload or replay URL from its delivery ID.

### Dead letters

Use the same table style, with event, type, exhausted attempt count, last error, archived time, and replay state. A row opens a drawer with failure details and two actions: View payload and Replay delivery.

Payloads load only when requested. Render JSON as escaped text in a scrollable monospace panel; never insert payload content as HTML. Provide copy and expand controls. Show an explicit unavailable state if the archive is gone, too large to inspect, invalid, or temporarily unreachable. An unavailable payload must not hide the failure metadata.

If the record already includes a replay, replace the replay action with "View replay" and show the new event ID. Keep the original failure visible. Replica lag may temporarily omit this link after a successful POST, so preserve the accepted replay locally until the replica catches up.

## Replay interaction

1. Replay delivery opens a confirmation dialog showing the original event, destination, and exhausted attempts. Explain: "This creates a new delivery. The original failure remains in history."
2. Confirmation creates one request UUID and sends the replay POST. Disable the confirmation control while the request is pending.
3. A 202 response shows "Replay accepted" and the new event ID. It does not show "Delivered" until a delivery record reports success.
4. Keep the request UUID and accepted replay IDs in session storage, scoped by tenant and dead-letter ID. A timeout or lost response offers an explicit retry with the same UUID. Never automatically resend a POST or generate a replacement key for an uncertain request.
5. Follow the new event through the read API. If it is not visible yet, show "Waiting for delivery details" and retain the accepted command. The original failure is never optimistically marked successful.
6. On 409, explain the conflict and refresh the source record. If another replay exists, show its link when available. Missing archives and service failures get specific messages rather than a generic success toast.

Only one replay is allowed per dead-letter record. A replay that exhausts its own retries creates another dead-letter record with its own replay option. The UI does not edit the archived payload or destination.

## Data and API boundaries

| UI function | Existing API |
| --- | --- |
| Summary cards | `GET /tenants/:tenantId/deliveries/summary` |
| History and status filter | `GET /tenants/:tenantId/deliveries` |
| Archived failures and replay links | `GET /tenants/:tenantId/dead-letters` |
| Saved payload | `GET /tenants/:tenantId/dead-letters/:deadLetterId/payload` |
| Replay command | `POST /tenants/:tenantId/dead-letters/:deadLetterId/replay` with `Idempotency-Key` |

Two gaps need explicit handling:

- There is no tenant-list API. The local dashboard starts with an entered tenant UUID and optional user-saved labels. A tenant switcher selects these local entries; it does not imply an authenticated account or a server-provided tenant directory. Never load signing secrets into browser configuration.
- There is no event-ID filter in delivery history. Before implementing View replay, add an optional, validated `eventId` filter to that endpoint, scoped to the selected tenant and pagination cursor. This is a planned API change. Scanning only the first history page cannot reliably locate a replay.

The client receives no database or AWS credentials. Use the API through the same browser origin, with a local development proxy or equivalent routing; cross-origin configuration is not implemented yet. Frontend framework and tooling will be chosen before implementation. Native CSS and system fonts are sufficient for this design; it does not require a chart or component library.

## Refresh and failure states

Refresh the overview and first history page every ten seconds while the tab is visible. Pause background refresh on later cursor pages so the list does not shift during inspection. Detail refresh and replay tracking update by ID without changing the selected row. Abort obsolete requests when switching tenants or filters, and ignore responses belonging to an older selection.

Show the last successful refresh time. The current API does not report replication lag or complete system health, so do not invent a live/healthy indicator. After replay, explain that delivery details may take a moment to appear. Elsewhere, describe replica reads as potentially delayed without claiming a measured lag.

| State | Presentation |
| --- | --- |
| Initial loading | Skeleton matching the table/card layout |
| No tenant selected | Tenant UUID input and a short setup explanation |
| Empty result | "No deliveries found" or "No archived failures found" |
| Filter has no matches | Preserve the filter and offer Clear filter |
| Refresh failed | Keep existing rows, show their last refresh time, and offer Retry |
| Payload unavailable | Keep metadata and show the archive-specific error in the payload panel |
| Replay result uncertain | Preserve the request key and offer Check status or Retry request |
| Record not visible after replay | Keep the accepted replay and wait for replica-visible details |

An empty result cannot prove that a tenant does not exist. Read failures never trigger direct database access or a primary fallback. Payload contents stay out of browser storage and URLs.

## Accessibility and completion checks

- Use semantic tables, labelled controls, keyboard-accessible rows, and visible focus indicators.
- Drawers and dialogs have accessible titles, Escape-to-close, managed focus, and focus restoration. Announce replay results and loading failures without relying only on transient notifications.
- Full IDs and timestamps remain available without hover-only interactions. Respect reduced-motion preferences.
- Verify desktop, narrow layout, long URLs, long errors, empty data, service failures, and JSON near the inspection limit.
- Verify a complete flow with real local data: select tenant, inspect failure, view payload, confirm replay, follow the new delivery, and reopen the preserved original failure.

## Implementation order

1. Add the tenant-scoped event-ID filter and its API tests.
2. Create the dashboard shell, visual tokens, and API client in `packages/dashboard`.
3. Add the tenant switcher, overview, delivery list, and drawer.
4. Add dead-letter browsing and on-demand payload inspection.
5. Add replay confirmation, request-key retention, and outcome tracking.
6. Verify responsive states, keyboard use, replica lag, and the end-to-end flow.

Jenkins deployment automation and Phase 8 service monitoring are separate from this interface. They do not appear as inactive navigation items in the tenant dashboard.
