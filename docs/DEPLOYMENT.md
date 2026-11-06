# Deployment

Host Waybill on one Linux VM using Azure for Students credit. Keep the existing public site, dashboard, API, publisher, worker, PostgreSQL primary and physical replica, Redis, receiver, Prometheus and Grafana together. SQS and S3 remain on AWS.

The cash budget stays **₹0**. This is a credit-funded portfolio deployment for roughly two months, not indefinite free hosting. Keep [the Oracle runbook](ORACLE_DEPLOYMENT.md) and `infra/oracle/` as a future hosting alternative.

## 1. Verify the account before preparing the VM

[Azure for Students](https://azure.microsoft.com/en-us/free/students/) still advertises $100 credit without a payment card. Activation requires eligible student verification. Use the full Azure for Students subscription; Students Starter does not establish access to the VM required here. Check the actual balance, expiry and subscription type after activation. [Offer terms](https://azure.microsoft.com/en-us/pricing/offers/ms-azr-0170p/).

In the portal, check whether **Standard_B2s, 2 vCPUs and 4 GiB RAM**, is available in an allowed region. Start with East US as the price reference. Credit does not guarantee quota, capacity or permission to create that size. Check the final validation screen without creating the VM yet. If it requests a card or a pay-as-you-go upgrade, stop and review the subscription. [SKU restrictions](https://learn.microsoft.com/en-us/azure/azure-resource-manager/troubleshooting/error-sku-not-available).

Optional read-only checks after installing Azure CLI and signing in:

```bash
az account show --query '{name:name,state:state}' --output table
az vm list-skus --location eastus --size Standard_B2s --all --output table
```

A restriction-free listing is a preliminary check; deployment validation can still fail because of capacity. Do not substitute an expensive size automatically.

Keep the subscription spending limit enabled. Do not upgrade it, add paid Marketplace products, or enable optional paid services. Azure disables student services when credit is exhausted; the spending limit does not cover every external Marketplace charge. [Spending limits](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit), [student credit exhaustion](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/azurestudents-subscription-disabled).

## 2. Cost and capacity

The public Azure Retail Prices API returned these USD reference rates. They are retail references, not a reservation or an account-specific quote. Recalculate for the selected region and remaining credit before creating resources. [Pricing API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices), [IP pricing](https://azure.microsoft.com/en-us/pricing/details/ip-addresses/).

| East US resource | Rate | 60-day estimate |
| --- | --- | --- |
| Linux Standard_B2s | $0.0416/hour | $59.90 for 1,440 hours |
| One 64-GiB E6 Standard SSD LRS disk | $4.80/month | $9.60, using two months conservatively |
| Disk mount allowance | API lists $0.47/month; include conservatively pending meter confirmation | $0.94 |
| One Standard static IPv4 | $0.005/hour | $7.20 |
| Fixed subtotal | | **$77.64** |
| Disk operations, small encrypted backups and transfer | Planning allowance; verify actual usage | $5.00 |
| Credit kept in reserve | Not available for planned usage | $15.00 |
| Required available Azure credit | | **About $97.64** |

Disk operations are separately metered at the returned $0.002 per 10,000 operations. The $5 allowance is not a cap. Longer calendar periods, region prices, backups, transfer and existing account usage can change the total. Check the portal quote and eligible charges rather than assuming a full $100 balance.

Central India's returned fixed subtotal is about $83.59 for the same period, before contingency and reserve. It would exceed a $100 balance with the allowances above. Prefer an eligible cheaper region or shorten the period after recalculating. Do not use Spot instances, reservations, a paid support plan, NAT Gateway, Azure Firewall, managed databases or a load balancer for this deployment.

### Memory gate

A local idle sample used roughly 738 MiB across PostgreSQL, replica, Redis, Prometheus and Grafana, plus about 143 MiB across API, publisher and worker. Those figures exclude Next.js, the host OS, builds and meaningful load. They support testing a 4-GiB VM; they do not prove hosted capacity.

Build before starting the full runtime, then test the complete stack on the actual VM. Keep at least 1 GiB available during the small acceptance workload, at least 15 GiB disk free, and no sustained swapping or OOM events. Use short monitoring retention and bounded logs. Never put data on the VM's temporary disk. B-series machines use CPU credits, so inspect sustained CPU behavior as well. [CPU credit model](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/b-series-cpu-credit-model).

If 4 GiB fails that test, pause the backend. Do not remove the replica or buy a larger VM silently. An 8-GiB quote must fit the actual remaining credit or the operating period must be shorter.

### AWS is a separate budget

Azure credit cannot pay for SQS or S3. Verify the existing AWS account's plan, remaining eligible credit, expiry, fair-queue pricing, storage, transfer and other usage before starting the hosted publisher or worker.

The current ten concurrent 20-second polls plus 30-second queue sampling imply about **2,764,800 idle SQS calls over 60 days**, before deliveries and retries. The monthly free request allowance alone is insufficient to assume this workload costs nothing. Preserve tenant MessageGroupId fairness. Run `bun infra/oracle/estimate.ts` for the repository calculation. [SQS pricing](https://aws.amazon.com/sqs/pricing/), [S3 pricing](https://aws.amazon.com/s3/pricing/).

The existing AWS guard accepts an ACTIVE FREE plan with a readable credit balance and fails closed otherwise. A statement that Free Tier lasts until a certain month is not enough. If the account is legacy/PAID or the guard cannot verify coverage, resolve that before enabling AWS traffic. Do not remove the guard to make startup pass.

## 3. Service layout

Use Ubuntu 24.04 x86_64, one VM, one persistent OS disk, one public IPv4 and one free [DuckDNS hostname](https://www.duckdns.org/). Install Bun 1.4.3 for Linux x64, Docker Compose, Caddy, Git and GnuPG.

| Service | Placement | Access |
| --- | --- | --- |
| Next.js public site, docs and dashboard | Native Bun process under systemd | Caddy to loopback 3001 |
| API | Separate Bun/systemd service | Caddy to 3000; block direct public access |
| Publisher and worker | Separate persistent Bun/systemd services | Outbound AWS calls; no public application port |
| Signature-verifying receiver | Native Bun/systemd service | 4000, local only |
| PostgreSQL primary and physical standby | Separate PostgreSQL 16 containers and volumes | Loopback 15432/15433; private replication network |
| Redis | Redis 7 container with AOF and noeviction | Loopback 6379 |
| Prometheus and Grafana | Existing pinned containers, Linux host networking | Loopback 9090/3300; metrics on 9100-9102 |
| SQS and S3 | Dedicated AWS queue and private bucket | Existing SDK integration over HTTPS |

Only 80/443 are public. Restrict SSH to the operator. Block all other ports through both Azure's network security group and the host firewall, including IPv6. Prometheus and Grafana remain private; access Grafana through an SSH tunnel and its own login.

The two database copies share a host. This preserves physical replica reads but provides no host failover or managed-database guarantee. The VM is for light portfolio use, not a capacity-tested public SaaS service.

## 4. Same-host HTTPS and real users

Use one hostname for the whole application:

```text
Website and dashboard: https://<host>
AUTH_API_ORIGIN:       https://<host>
AUTH_WEB_ORIGIN:       https://<host>
GitHub OAuth callback: https://<host>/auth/github/callback
```

Reuse the existing Caddy routing:

| Path | Upstream |
| --- | --- |
| `/auth`, `/auth/*`, `/tenants`, `/tenants/*`, `/events`, `/events/*` | API |
| `/api/observability`, `/app`, `/app/*` | Next.js |
| Public pages, `/docs` and assets | Next.js |
| Database, receiver, metrics and monitoring ports | No public route |

Keep host-only Secure/HttpOnly cookies, Origin/CSRF checks and no-store responses. Preserve `Idempotency-Key` for replay. Never broaden cookie domains or expose Prometheus to work around routing. Next.js must reach its configured HTTPS `/auth/me` URL for operator verification.

Public pages are open to everyone. GitHub sign-in creates identity; workspace access still requires an explicit membership grant. Initially invite trusted testers into the demo workspace. Members share management permissions, so do not grant unknown visitors access to a workspace containing other people's data or keys.

The current worker has one configured destination, and the included receiver accepts one tenant. Testers can submit real events with scoped API keys, inspect deliveries, and exercise recovery in that workspace. They cannot configure independent webhook destinations through the dashboard. Public tenant creation and per-tenant destination management would be separate application work.

## 5. Reuse and preparation work

Keep `infra/oracle/` intact. Reuse its Caddy rules, PostgreSQL initialization and reader grants, replica entrypoint, monitoring definitions, service entrypoints and guard behavior. Prepare a small `infra/azure/` variant before deployment:

| File group to prepare | Required adjustment |
| --- | --- |
| Compose and host checks | x86_64 images, 4-GiB capacity check, 64-GiB disk, bounded connections/memory/logs and private ports |
| systemd units and launch wrappers | Provider paths, smaller reviewed limits, restart-on-failure, lease validation, independent API/publisher/worker/receiver processes |
| Environment and cost-policy examples | Same app settings; actual account IDs, start/end, expiry and reserve configured privately |
| Backup script and timer | Keep encrypted database/role dumps; replace the Oracle-only upload URL with private Azure Blob Storage upload using narrowly scoped access |
| Health and stop scripts | Validate primary, streaming standby, Redis, disk, memory and scrapes; restore preview routing on a backend safety stop |

These Azure files do not exist yet. Do not run the Oracle setup unchanged: it enforces ARM64 and at least 8 GiB RAM, fixes Compose to ARM64, and accepts only Oracle backup upload URLs. Its units and wrappers also contain provider paths. Review the Azure variant's aggregate memory limits; copying the old per-process maxima would oversubscribe the 4-GiB host.

The application features, API contracts, UI, SQS/S3 architecture and database schema stay unchanged. Generate Prisma and install native dependencies on the Linux x64 target. Existing API/worker Dockerfiles remain useful packaging checks; native systemd processes keep the loopback metrics model simple.

## 6. Deployment sequence

1. Activate and verify Azure for Students, credit, spending limit, VM eligibility and the complete quote. Verify AWS separately. No resource creation before these checks pass.
2. Prepare and locally validate the Azure configuration listed above. Verify GitHub Actions `checks`, `web` and `database` jobs for the release SHA.
3. Create the selected VM, persistent disk and public IP inside one project resource group. Configure SSH/firewalls, DuckDNS and Caddy. Disable optional VM insights, paid log ingestion and backup products in the setup wizard.
4. Install the pinned tools and reviewed release under `/opt/waybill/current`. Store service environment files under `/etc/waybill`, outside Git. Build the website with the final HTTPS origin.
5. Start Next.js behind Caddy in preview mode. Check public pages, docs, fonts, animations and responsive layouts. Hold `/app`, auth, tenant APIs, events and Observability behind maintenance responses until the backend is ready.
6. Start private PostgreSQL and Redis, apply migrations once, grant reader permissions and start the physical replica. Verify recovery mode, streaming, catch-up and denied reader access to security tables.
7. Register a hosted GitHub OAuth app. Configure session mode, AWS resources and the hosted receiver's tenant/signing secret. Create only intended tenant data; do not copy the laptop database or credentials automatically.
8. Configure encrypted off-host backups and verify a restore. Set the backend guard window to the earlier of the planned end and verified AWS expiry minus the existing safety margin. Test failure-to-start without a valid lease.
9. Start receiver, API, publisher and worker with metrics enabled under supervision. Validate dependencies and all three private scrapes. Then enable live HTTPS routing and complete real GitHub sign-in.
10. Grant intended memberships using the existing command. Configure operator IDs only in the web service. Run the small acceptance workload, reboot/recovery checks and memory gate before sharing the link.

Existing commands for the reviewed Linux release, with the matching protected environment selected:

```bash
bun install --frozen-lockfile
bun run prisma:generate
bun run check:backend
bun run check:web
bun run test:backend
bun test packages/web/tests
AUTH_API_ORIGIN=https://REPLACE.duckdns.org bun run build:web
```

For database initialization and access, use the installed Prisma CLI and existing membership command:

```bash
sudo /usr/local/bin/bun --env-file=/etc/waybill/migrations.env packages/shared/node_modules/prisma/build/index.js migrate deploy --schema packages/shared/prisma/schema.prisma
sudo /usr/local/bin/bun --env-file=/etc/waybill/api.env run grant:tenant --github-id <numeric-id> --tenant <tenant-uuid>
```

Migrate the primary only. Do not use `migrate dev`, reset a hosted database, or point the laptop replica setup script at the VM unchanged. Each runtime service uses its own protected environment and non-watch entrypoint.

## 7. Verification and operation

Before sharing the full application:

- Real GitHub callback, workspace selection, logout, expired sessions and cross-tenant denial work over HTTPS.
- Small and S3-backed events reach the signature-verifying receiver and durable success. A controlled failure retries; exhaustion archives; authorized replay creates one new durable event.
- API keys reveal the secret once, authorize ingestion only, and reject use after revocation. Cookie writes require Origin and CSRF.
- Operator Observability shows actual system metrics. Non-operators are restricted, Grafana requires its separate login, and private ports are inaccessible publicly.
- A paused replica gives a safe read error while primary writes and delivery continue. Restarted publishers/workers retain accepted work and recover through the existing at-least-once pipeline.
- Primary/replica, Redis AOF, monitoring and certificates survive service restart and reboot. Restore an encrypted backup into separate storage.
- The complete VM passes the memory/disk gate with a small bounded workload. Do not run the local load-test scripts against hosted resources unchanged.

Back up the database and roles daily with public-key encryption. Keep the private decryption key offline, retain a small rolling set in private Azure Blob Storage, and download a restore-tested copy before shutdown. Include backup storage/operations in the credit quote. Azure backups do not preserve application payloads held in S3; retain or export the required objects too.

Keep logs rotated and secrets redacted. Check credit, disk/WAL growth, backups and CPU credits regularly. Budget emails are reminders, not a hard spending cap. Keep the actual student spending limit enabled and leave the reserve untouched. Do not enable paid monitoring exports or third-party Marketplace services.

Before the planned end or credit/benefit expiry, block ingress, drain accepted work while coverage permits, take the final backup, and stop the backend. API and worker currently rely on SQS visibility recovery after an abrupt stop; they do not have explicit termination drains.

Stopping or deallocating a VM does not remove disk, static-IP or object-storage costs. Export data, then explicitly remove the dedicated Azure resources and AWS storage/queue resources before their coverage ends. Azure credit exhaustion can disable the whole host, including the public site. Do not depend on that event as the backup procedure. [Static IP billing](https://azure.microsoft.com/en-us/pricing/details/ip-addresses/).

For rollback, restore the previous schema-compatible release while preserving live database volumes, accepted event IDs, outbox rows, queued messages and archives. Do not restore an old snapshot over newer accepted work.

## If student activation or VM access fails

First check whether the existing AWS account already has usable compute credits for a separately quoted VM of sufficient size. That would reuse an existing account rather than require Oracle registration; it still needs account verification and a complete compute/disk/IP quote. A 1-GiB free micro VM is not the proposed full-stack host.

If neither student VM access nor covered AWS compute is available, there is no verified card-free, ₹0, continuously hosted option here for the unchanged complete stack. Ask the university about a suitable hosted Linux VM, or reconsider the budget. A tunnel to the laptop is an intermittent demo, not an independent deployment.

Do not split the project across free plans and call it complete. [Render Free](https://render.com/docs/free) has sleeping web services, no free persistent disks and a database that expires after 30 days; its [background workers are not free](https://render.com/docs/your-first-deploy). [Railway](https://docs.railway.com/pricing/free-trial) offers a $5/30-day trial followed by a $1 monthly allowance, which is not a verified budget for this stack. Hosting public pages alone would still leave the dashboard, workers and private monitoring unresolved.

The immediate next step is **Azure student activation and the VM eligibility/quote check**. Account credit and capacity are not verified yet. Infrastructure adaptation, hosted tests and deployment follow those checks; nothing in this plan has provisioned services.
