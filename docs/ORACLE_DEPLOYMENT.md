# Oracle Always Free portfolio deployment

Run the complete public website, documentation, GitHub-authenticated dashboard, API, publisher, worker, private receiver, PostgreSQL primary/physical replica, Redis, and private Prometheus/Grafana on one Always Free ARM64 VM for at most 60 days. Budget remains **₹0/month**. The intended start is in November 2026; calculate the actual end from the approved launch time. February 2027 AWS eligibility is an owner-provided expectation, not a verified account fact.

The prepared configuration is persistent, not a one-hour demo. Backend services restart after crashes and start at boot while their running permission remains valid. There is no new application feature, UI redesign, cloud deployment, or resource purchase in this change.

## Decisions and financial boundary

- Keep the existing Oracle topology. Verify home-region A1 capacity, approximately 2 OCPUs/12 GB under currently published free limits, and an eligible 80 GB boot volume. Count every existing allocation against the account's free allowance. No paid upgrade, extra VM, NAT gateway, load balancer, or paid domain. Oracle can reclaim idle instances; do not manufacture traffic to prevent that.
- Keep SQS, MessageGroupId fairness, S3 claim-checks, physical replica reads, real OAuth, and all current dashboard behavior. Public pages launch first; backend access follows verified dependencies and account coverage.
- Continuous SQS use can exceed the basic request allowance. Credits, fair-queue coverage, S3 coverage, transfer, and account-wide usage must be checked before launch.
- The automatic guard requires an **ACTIVE AWS FREE account plan** with a numeric remaining USD credit balance from `GetAccountPlanState`. Legacy/PAID accounts, missing balances, errors, or unsupported responses fail closed. A legacy Free Tier expiry email does not establish a hard no-charge account boundary. If the account reports PAID, pause backend activation and review this blocker; do not upgrade or weaken the guard.
- AWS billing/credit observations can lag. A reserve and local traffic circuits reduce exposure; they are not exact billing meters. The AWS FREE plan's no-upgrade boundary is the financial backstop. Verify eligible services and that no paid-only feature or auto-upgrade is activated. If this cannot be established, only public pages can be launched under the strict budget.

Sources: [Oracle Always Free limits and reclamation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [AWS plans](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html), [free plan API and no-cost access](https://aws.amazon.com/free/free-tier-faqs/), [GetAccountPlanState](https://docs.aws.amazon.com/cli/latest/reference/freetier/get-account-plan-state.html).

## 60-day cost worksheet

Run `bun infra/oracle/estimate.ts` to derive the idle estimate from the actual worker/sampler constants. The worker launches **10 concurrent 20-second receives**, not one. Earlier one-hour planning understated idle requests.

| Activity | 30-day estimate | 60-day estimate / assumption |
| --- | --- | --- |
| Empty SQS receives | 1,296,000 | 2,592,000 |
| Queue sampling every 30 seconds | 86,400 | 172,800 |
| Baseline SQS API calls | 1,382,400 | **2,764,800**, before workload/SDK retries/errors |
| Portfolio workload | 100 accepted events/day | 6,000 events; assume small inline events, 10% large payloads, 1% exhausted failures, one replay per archived failure |
| Additional queue allowance | Workload-dependent | Reserve 250,000 requests for sends/nonempty receives/deletes/visibility changes/chunks; this is a planning allowance, not a bound |
| S3 planning allowance | Includes archive viewing/replay | 5,000 PUT/LIST-class and 30,000 GET/HEAD-class operations over the period, at most 2 GB retained; no storage versioning or cold storage |
| S3 storage | At most 2 GB retained | Budget up to 4 GB-months conservatively rather than assuming all storage appears at the end |
| AWS internet transfer | Account-wide allowance must be checked | Plan at most 10 GB for this project; include queue responses and large-payload downloads |
| Free Tier credit checks | One per minute | 86,400 read-only Free Tier API calls, documented as no-cost; no Cost Explorer polling |
| Oracle off-host backups | Two encrypted uploads/day | About 120 uploads; eight daily copies must fit the verified free Object Storage allowance |

The standard SQS allowance is monthly and account-wide, not a transferable 60-day pool. A 60-day window can touch three calendar months. Treat every grouped queue operation as potentially additionally fair-metered until the selected-region quote confirms otherwise. Rate example for budgeting only: at USD 0.40/million standard and USD 0.10/million fair requests, 3.015 million requests would be about USD 1.51 gross if every request were fair-metered and no allowance applied. A three-times request contingency is about USD 4.52 at those illustrative rates. Confirm actual region prices; do not claim that exact bill.

At illustrative S3 Standard rates of USD 0.005/1,000 PUT-class, USD 0.0004/1,000 GET-class, and USD 0.023/GB-month, the stated S3 envelope is about USD 0.13 before transfer and tax. Console browsing, SDK retries, larger payloads, other account users, and failed requests can change usage. Before launch, require verified applicable credits/allowances covering a **USD 10 planning envelope plus at least USD 5 untouched shutdown reserve**, and include any other account consumption. Credits are not cash budget approval.

[SQS pricing](https://aws.amazon.com/sqs/pricing/), [S3 pricing](https://aws.amazon.com/s3/pricing/), [AWS S3 rate example](https://aws.amazon.com/blogs/storage/run-spark-31-faster-and-optimize-compute-costs-with-amazon-s3-express-one-zone-on-amazon-emr/). Region, eligibility, rounding, and monthly allowance rules require account verification. No CloudWatch custom metrics/logs, Cost Explorer calls, KMS customer keys, SNS pipeline, or paid backup service are required.

## Prepared infrastructure

| Files | Purpose |
| --- | --- |
| `infra/oracle/compose.yml`, existing replica entrypoint | Persistent private PostgreSQL/standby/Redis and monitoring; ARM64 images, memory limits, Docker log rotation, healthchecks, restart policies |
| `Caddyfile`, `preview.caddy`, `live.caddy` | One HTTPS hostname; website-only preview followed by fixed API/application routing |
| `systemd/waybill-web.service` | Continuous Next.js, bounded restarts/resources |
| `systemd/waybill-backend@.service`, `run.sh` | Persistent API/publisher/worker/receiver, restart-on-failure, memory/CPU/task limits, and independent lease expiry checks |
| `guard.ts`, guard service/timer, `stop.sh`, `lease-stop.sh` | Read-only credit checks, 60-day/expiry cutoff, usage and health circuits, backup freshness, latched fail-safe stop |
| `backup.sh`, backup service/timer | Daily noninteractive public-key encryption and upload to verified free OCI Object Storage |
| `systemd/journald-waybill.conf` | Dedicated application journal capped at 256 MB and seven days; Docker logs remain separately bounded |
| `env/*.example`, policy examples | Placeholder-only configuration, owner-reviewed account policy and least-privilege IAM templates |

The old `waybill-demo@.service` is retired and cannot be manually started. Disable installed old instances when migrating. The new services have no one-hour timeout.

### Fail-safe behavior

1. Owner fills `/etc/waybill/cost-policy.json`: exact account ID, actual UTC start/end within 60 days, verified benefits expiry, covered-services acknowledgement, minimum reserve, and modest hourly usage thresholds. No secrets belong in that JSON. Defaults are examples, not automatic eligibility.
2. A root-owned systemd timer runs the guard every minute using a separate credential with only `freetier:GetAccountPlanState`. That API is not called by public users or the frontend.
3. Running permission ends at the earliest of the planned end, verified benefits expiry minus **72 hours**, or API-reported plan expiry minus **72 hours**. Credits at/below the configured reserve, malformed/missing policy, wrong account, PAID/expired plan, API failure, stale backup, excessive usage, or sustained unhealthy dependencies revoke permission.
4. The root guard renews a root-owned 180-second lease. Each backend wrapper independently checks it every ten seconds, so a stopped/hung timer cannot authorize indefinite service. Root failure actions and wrapper stop hooks restore preview routing and latch shutdown. A restart never bypasses the lease.
5. PostgreSQL, replica, Redis, web, and monitoring remain available locally; backend units stop. Accepted work and volumes are preserved. Full dashboard data/login may be temporarily unavailable after a safety stop; do not promise uninterrupted service when cost/security gates fail.
6. Shutdown stays latched under `/var/lib/waybill-guard/STOPPED`. Recovery needs owner review, an amended valid policy if appropriate, removal of that specific latch, a successful guard check, and explicit service restart. No automatic account upgrade or credit top-up.

Usage circuits use existing Prometheus counters for SQS calls, accepted ingestion/replay, and archive reads. Queue sampling adds a fixed allowance. SDK retry attempts, payload chunks, S3 bytes, and other account activity are not completely metered there. They are conservative anomaly triggers, not an enforceable AWS currency cap. Dependency/scrape health gets a two-minute startup/restart grace; unknown monitoring responses fail closed. A backup must have successfully uploaded within 36 hours.

Attach the reviewed `runtime-cutoff-policy.json.example` explicit date-deny to every dedicated runtime AWS principal, using the same or earlier effective cutoff. This is a second request boundary if the VM timer fails. It does not stop S3 storage charges. Export needed objects and remove dedicated AWS storage/resources before coverage ends, with separate approval. No script deletes AWS resources automatically.

## Exact deployment sequence

Commands below are future commands for the approved VM. Nothing has been deployed. Replace placeholders first and never overwrite existing configured environment files with examples.

### 1. Owner: verify accounts, free capacity, and hostname

Confirm Oracle home-region free A1 capacity, chosen image/CPU/RAM/boot/IP/network cost, total storage allocations, and the private backup bucket's free capacity. Choose ARM64 Ubuntu 24.04 and a free DuckDNS hostname. Do not select trial-only paid resources. Allow public 80/443, restricted SSH, and no direct database/API/receiver/monitoring ports, including IPv6. Preserve OCI-required firewall rules. Approval is required before VM, DNS, bucket, IAM, OAuth, or firewall changes.

Verify AWS in the account console: exact plan type, remaining eligible credits, actual expiry timestamp, SQS standard/fair allowances, S3 and transfer eligibility, other active services, and no auto-upgrade. November launch through roughly January ends before the reported February expiry, but only actual timestamps authorize it. Confirm the read-only API response is supported. If PAID/legacy, stop here for backend activation; the guard deliberately refuses to assume a no-charge boundary.

Set free AWS Budgets email notifications for actual and forecast cost/usage and enable available Free Tier notifications. Budgets without actions are free, but their data updates only several times a day. Do not enable paid actions, reports, or notifications without verification. Alerts supplement the guard and never authorize continued spending. [Budgets pricing/FAQs](https://aws.amazon.com/aws-cost-management/aws-budgets/faqs/), [update delays](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html).

### 2. Prepare the release and launch public pages

Install approved system packages: Docker Compose, Caddy, Git, OpenSSL, unzip, CA certificates, GnuPG, and curl. Install verified Bun 1.4.3 aarch64 at `/usr/local/bin/bun` and an official ARM64 AWS CLI v2 supporting `freetier get-account-plan-state` at `/usr/local/bin/aws`. AWS CLI is an operations tool; no application dependency is added. Put the reviewed repository release at `/opt/waybill/current`, owned by the deployment account and readable by the unprivileged `waybill` service user.

```bash
sudo useradd --system --create-home --home-dir /var/lib/waybill --shell /usr/sbin/nologin waybill
sudo install -d -m 0750 -o root -g waybill /etc/waybill
cd /opt/waybill/current
bash infra/oracle/check-host.sh
bun install --frozen-lockfile
bun run prisma:generate
DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused bun test packages/web/tests
DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused bun run test:backend
bun test ./infra/oracle/guard.test.ts ./infra/oracle/wrapper.test.ts
bun run check:web
bun run check:backend
bun node_modules/typescript/bin/tsc --noEmit -p infra/oracle/tsconfig.json
AUTH_API_ORIGIN=https://REPLACE.duckdns.org bun run build:web
```

Use the same final HTTPS hostname at build time and in both AUTH origins. Build as the deployment owner; do not copy macOS node_modules or `.next`. Dummy test URLs are only for injected-store tests, never service configuration. ARM64 support was checked against the lockfile, installed Prisma target list, and image manifests; Linux runtime still requires this VM verification.

Install matching `env/web.env.example` and `env/caddy.env.example` as protected `/etc/waybill/web.env` and `caddy.env`, then fill their hostname values. Web environment is root:waybill 0640; Caddy's environment is root:caddy 0640. The systemd manager reads the latter as root. Keep the runtime user out of the Docker group.

```bash
sudo install -m 0644 infra/oracle/systemd/waybill-web.service /etc/systemd/system/
sudo install -d /etc/systemd/system/caddy.service.d
sudo install -m 0644 infra/oracle/systemd/caddy-override.conf /etc/systemd/system/caddy.service.d/waybill.conf
sudo install -m 0644 infra/oracle/systemd/journald-waybill.conf /etc/systemd/journald@waybill.conf
sudo install -m 0644 infra/oracle/Caddyfile /etc/caddy/Caddyfile
sudo install -m 0644 infra/oracle/preview.caddy /etc/caddy/waybill-mode.caddy
sudo install -d -o waybill -g waybill packages/web/.next/cache
sudo systemctl daemon-reload
sudo env WAYBILL_HOST=REPLACE.duckdns.org caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now waybill-web caddy
sudo systemctl restart caddy
```

The public site/docs are now testable without AWS. Backend paths return a no-store maintenance response. Keep public authentication unavailable until real configuration is ready.

### 3. Owner: OAuth, dedicated AWS access, and private environment files

Register a separate GitHub OAuth app: homepage `https://<host>`, callback `https://<host>/auth/github/callback`. Inject its secret directly into api.env. Use a dedicated standard SQS queue and private S3 Standard bucket, SSE-SQS/S3-managed encryption, no public bucket access, and no paid KMS or optional logging/analytics. Review and attach only required runtime permissions and the dated deny policy. A separate read-only principal supplies guard.env; do not reuse administrator credentials.

Install and fill the other `env/*.example` files in `/etc/waybill`. Use root:waybill 0640 for API/publisher/worker/receiver and root:root 0600 for infra/migrations/guard/backup. Independently generated hex database passwords avoid URL/interpolation ambiguity. Missing CHANGE_ME values must be fixed before startup. Do not copy laptop secrets or expose credentials in logs/history. Optional temporary AWS_SESSION_TOKEN belongs only in the relevant protected file.

### 4. Initialize persistent dependencies and migrations

```bash
dc() { sudo docker compose --env-file /etc/waybill/infra.env -f /opt/waybill/current/infra/oracle/compose.yml "$@"; }
dc config --quiet
dc up -d --wait postgres redis
sudo /usr/local/bin/bun --env-file=/etc/waybill/migrations.env packages/shared/node_modules/prisma/build/index.js migrate deploy --schema packages/shared/prisma/schema.prisma
sudo /usr/local/bin/bun --env-file=/etc/waybill/migrations.env packages/shared/node_modules/prisma/build/index.js migrate status --schema packages/shared/prisma/schema.prisma
dc exec -T postgres psql -U webhook -d webhook_platform < infra/oracle/grant-reader.sql
dc up -d --wait postgres-replica
dc exec -T postgres psql -U webhook -d webhook_platform -c "SELECT state, sent_lsn, replay_lsn FROM pg_stat_replication"
dc exec -T postgres-replica psql -U webhook -d webhook_platform -c "SELECT pg_is_in_recovery()"
sudo /usr/local/bin/bun --env-file=/etc/waybill/api.env run check:aws
sudo /usr/local/bin/bun --env-file=/etc/waybill/api.env run seed:tenant
```

AWS checks make requests and require prior approval. Keep admin credentials for migrations, runtime credentials for primary writes/security, restricted reader credentials for physical replica queries. Test reader SELECT on permitted data and denial on `users`, `auth_sessions`, `api_keys`, and `tenants`. Confirm catch-up and readonly transactions; do not replace the standby with a read-only primary.

Record the demo tenant ID and transfer its generated HMAC secret privately into receiver.env. Both API and worker keep `RECEIVER_URL=http://127.0.0.1:4000/webhook`. The existing real signature-verifying receiver supports one tenant; only grant that workspace to invited users. A public portfolio does not mean open tenant signup or publicly shared API keys. First-boot init scripts do not rotate existing database passwords.

### 5. Configure automatic encrypted off-host backups before enabling the guard

Use a verified free private OCI Standard Object Storage bucket for database backups, not S3. Owner imports only the GPG public encryption key into root's keyring and keeps the private key offline. Set a write-only prefix-scoped preauthenticated upload URL and full key fingerprint in protected backup.env. The URL is a secret; its validity must cover the deployment and final backup. Configure an eight-day object lifecycle/retention only after verifying free request/storage limits; keep versioning off. Eight daily encrypted snapshots must fit the remaining free allowance with headroom.

Install `waybill-infra.service`, `waybill-backup.service`, and their timer, then:

```bash
sudo install -m 0644 infra/oracle/systemd/waybill-infra.service infra/oracle/systemd/waybill-backup.service infra/oracle/systemd/waybill-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now waybill-infra.service
sudo systemctl start waybill-backup.service
sudo systemctl enable --now waybill-backup.timer
sudo journalctl --namespace=waybill -u waybill-backup --since today
```

A successful run dumps database and roles, encrypts without a private key on the VM, uploads both over HTTPS, then updates a root-owned success timestamp. Failed uploads do not mark success. Daily runs retry with bounded delays; local copies rotate after seven days, remote retention is owner-configured. Test decrypting and restoring a downloaded backup into separate storage before proceeding. A copy on the same reclaimable VM is not an off-host backup.

### 6. Enable the persistent guarded backend

Fill `/etc/waybill/cost-policy.json` from the example, root:root mode 0600. Choose an exact start and end within 60 days, not a hardcoded February date. Set coveredServicesVerified true only after account/service coverage and at least the forecast-plus-reserve balance are verified. Confirm the earlier of all expiry sources, subtract 72 hours, and use that effective cutoff in the runtime IAM deny template.

Install the new guard/stop/backend units and timer from `infra/oracle/systemd/` into `/etc/systemd/system/`. Existing demo units, if installed, must be stopped and disabled; no application data is removed. Enable in this order:

```bash
sudo install -m 0644 infra/oracle/systemd/waybill-backend@.service infra/oracle/systemd/waybill-guard.service infra/oracle/systemd/waybill-guard.timer infra/oracle/systemd/waybill-stop.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now waybill-guard.timer
sudo systemctl start waybill-guard.service
sudo systemctl enable --now waybill-backend@receiver.service waybill-backend@api.service waybill-backend@publisher.service waybill-backend@worker.service
sudo systemctl status waybill-backend@api waybill-backend@publisher waybill-backend@worker waybill-backend@receiver
sudo /usr/local/bin/bun --env-file=/etc/waybill/guard.env infra/oracle/guard.ts check
```

The first guard run allows two minutes for initial backend scrapes; start the four units immediately after it succeeds. Re-run the final check after one scrape interval; it requires healthy services, not just startup grace. If setup takes longer or any policy check fails, shutdown latches. Correct the actual cause before resetting; never create a lease by hand.

After successful private health, callback, and credit checks:

```bash
sudo install -m 0644 infra/oracle/live.caddy /etc/caddy/waybill-mode.caddy
sudo env WAYBILL_HOST=REPLACE.duckdns.org caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Sign in through real GitHub, obtain the verified numeric ID, then run `grant:tenant --github-id <numeric-id> --tenant <uuid>` using api.env. Set only approved immutable IDs in web.env's operator allowlist and restart web. Verify secure host-only cookies, CORS/CSRF, tenant isolation, and the server's own HTTPS `/auth/me` path. No session bypass, cookie widening, or public monitoring proxy.

## Zero-cost verification and end-to-end acceptance

Before declaring the portfolio live:

- [ ] OCI console confirms free compute/image/IP/network/disk/object storage selections and all account-wide quotas; no paid account upgrade.
- [ ] AWS actual account plan, numeric credits, covered services, exact expiry, reserve, and cutoff deny are verified; unsupported/PAID responses remain blocked.
- [ ] Free budget/Free Tier email notifications are configured; no CloudWatch custom metrics, paid logs, Cost Explorer polling, NAT, paid backup plan, or KMS key.
- [ ] Every CHANGE_ME/REPLACE value is resolved privately; secrets stay outside Git. Guard credential cannot ingest events, read payloads, mutate infrastructure, or upgrade the account.
- [ ] All three Prometheus targets UP, Grafana datasource healthy through private SSH tunnel, operator authorized and non-operator denied. Existing dashboards use real series; no fabricated zeroes.
- [ ] Real login, workspace access, Overview, list/details, API-key creation/revocation, small delivery, S3-backed delivery, retry, exhaustion/archive, payload retrieval, replay, and logout pass with a few owner-approved events.
- [ ] Invalid CSRF and cross-tenant requests fail. Public site/docs and all four responsive sizes remain unchanged. No private service port is publicly reachable.
- [ ] Restart each application process and reboot the VM during a maintenance pause: persistent sessions/data/outbox survive, containers restart, leases renew, worker resumes via existing visibility semantics, and duplicate delivery remains possible.
- [ ] In an approved maintenance window, simulate an expired policy, unavailable credit response, reserve threshold, stopped timer, and failed backup. Backend stops and stays latched, public pages remain online, volumes/messages remain intact. Restore valid settings only after review.
- [ ] Download/decrypt/restore a backup into separate storage, verify records/roles and S3 dependencies, and measure RAM/disk/OOM behavior on actual ARM64 Linux.

Never run laptop-only load/recovery helpers against hosted resources unchanged. No synthetic traffic was generated during preparation.

## Two-month operations and shutdown

| When | Work |
| --- | --- |
| Launch | Record exact 60-day maximum end, verified expiry/credits/reserve, account coverage, actual resource use, release SHA, restore result, and monthly request estimate. Keep private operators/keys limited. |
| Every minute, automatic | Free Tier status/credit check, deadline, lease renewal, local usage circuits, resource/dependency/scrape health. Stop on invalid evidence. |
| Daily, automatic | Encrypted database and role backup to verified free off-host storage; bounded retries and retention. Backend refuses to continue with a backup older than 36 hours. |
| Weekly, owner | Check account-wide bill/credits, future coverage, budget email delivery, OCI quotas/reclamation notices, backups/restore accessibility, disk/WAL/log growth, and actual workload against estimate. Review unexpected increases without raising caps automatically. |
| A week before end | Confirm final export/cleanup time, retain a restore-tested backup and needed payloads, and schedule approved resource cleanup before AWS coverage ends. |
| Planned end or earliest safety cutoff | Stop ingress and backend, leave website/docs online, export preserved data, and revoke dedicated runtime credentials. The guard never extends the window by itself. |

Prometheus/Grafana provide service monitoring without CloudWatch. Journald namespace `waybill` and bounded Docker json logs provide local diagnostics; use `journalctl --namespace=waybill -u <unit>` and `dc logs --tail=100 <service>`. Health scripts check low disk/memory, PostgreSQL, streaming replica, Redis, and scrape freshness. The VM clock must report NTP synchronization; an unsynchronized clock fails the health gate. Process crashes restart with delay and a burst limit; sustained failure latches off rather than loops indefinitely.

For a planned stop, install preview routing and reload Caddy first. Keep a healthy receiver while the outbox and visible/in-flight/delayed queue settle; queue depth is approximate. Run the final backup, then `sudo systemctl start waybill-stop.service`. A credit/deadline emergency stops immediately rather than spending more to drain. API/worker still lack explicit termination drains: a crash/stop may redeliver via visibility expiry. Never purge accepted work, database volumes, or queues to hide it.

**Stopping processes does not remove S3 storage charges.** Before verified coverage expires, owner approves export of needed payloads and deletion of only dedicated project objects/versions and queue resources, then revokes their credentials and checks the account for residual storage, logging, keys, and services. No cleanup script can silently delete live cloud data. The 72-hour margin is for backup/export/cleanup, not permission to incur charges. If AWS evidence becomes unavailable earlier, keep backend stopped and perform approved account cleanup while coverage remains.

### Recovery and rollback

Pause ingress using preview mode, review root guard logs and actual account/health/backup state, and stop backend before changing releases. Do not restore an old paid/expired policy or lower the reserve to make startup pass. If the cause is corrected within the approved operating window, remove only `/var/lib/waybill-guard/STOPPED`, reset failed units, run the guard, restart backend, verify healthy checks, and explicitly restore live routing.

For application rollback, use the previous immutable, schema-compatible release and its Linux-native generated dependencies. Preserve current database volumes, accepted event IDs, outbox, replay audit records, S3 objects, and queued work. Back up before migrations; use migrate deploy, never migrate dev/reset. Incompatible migrations require a forward fix or separately reviewed recovery, not blind snapshot restore over newly accepted events. Test backup restore separately rather than overwriting the live primary. Lost replica-slot WAL requires reviewed replica rebuild; no primary fallback.

## Remaining owner checkpoints

1. Verify/provide Oracle free capacity, SSH access, free hostname/DNS, and network approval; approve installation/deployment on that VM.
2. Verify AWS plan/API support, at least forecast-plus-reserve eligible credits, exact February expiry if applicable, service allowances, free alerts, and dedicated IAM/cutoff policies. PAID/legacy plan is a strict-budget blocker, not assumed eligible.
3. Register hosted GitHub OAuth and inject credentials directly; choose authorized tenant/operator IDs and complete real browser login.
4. Configure verified free OCI off-host backup storage, prefix-write URL, lifecycle/expiry, and offline GPG private-key custody; approve a restore test.
5. Approve bounded real webhook tests, restart/shutdown validation, and the final data-export/resource-cleanup window. Handle Git manually.

Local preparation and application regression tests can be completed without cloud access. Actual account eligibility, ARM64 runtime, billing coverage, private routing, delivery, backup upload/restore, and reboot/fail-safe behavior require the approved accounts/VM. No deployment, account upgrade, secrets change, cloud request with credentials, commit, or push has been performed.

## Local preparation checks

| Check | Result |
| --- | --- |
| Deployment guard and actual shell-wrapper tests | 12 passed, 0 failed; covers invalid accounts/policies, deadlines, reserve, leases, monitoring values, health grace, backup freshness, child shutdown and failure propagation |
| Frontend/authentication/security tests | 67 passed, 0 failed |
| Backend tests | 114 passed, 6 opt-in database tests skipped, 0 failed |
| Total executed tests | 193 passed, 0 failed; 6 skipped |
| Backend, frontend, deployment TypeScript | Passed |
| Production web build | Passed; approved routes preserved |
| Compose with monitoring profile | Passed configuration parsing with example placeholders and environment-file resolution disabled |
| Shell syntax and request estimate | Passed; 2,764,800 baseline queue calls for 60 days |
| Actual Linux systemd/Caddy/container execution | Not verified: laptop lacks systemd/Caddy and Docker daemon is stopped |
| Cloud eligibility, credits, IAM cutoff, encrypted upload/restore, real OAuth/delivery, and VM reboot | Not verified: requires owner-approved account/VM access |

The process-wrapper tests use temporary local stub processes to exercise supervision, not fake application records or authenticated sessions. They do not prove Linux systemd behavior. No deployed services, environment secrets, application code, approved designs, or the unrelated architecture PDF deletion were changed.
