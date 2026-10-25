export const DOC_TOPICS = [
  { slug: "introduction", title: "Introduction", group: "Start here", description: "Understand Waybill and send your first event over HTTP.", keywords: "webhook overview curl typescript python", sources: ["README.md", "packages/api/src/routes/events.ts"] },
  { slug: "getting-started", title: "Getting started", group: "Start here", description: "Set up Bun, PostgreSQL, Redis, AWS and the local receiver.", keywords: "install docker seed tenant setup quickstart secret", sources: ["README.md", ".env.example", "packages/shared/scripts/seed-tenant.ts", "packages/shared/scripts/test-receiver.ts"] },
  { slug: "authentication", title: "Authentication", group: "Start here", description: "Distinguish caller authentication from outbound HMAC verification.", keywords: "security signature hmac sha256 raw bytes secret authorization", sources: ["packages/api/src/index.ts", "packages/shared/src/webhook-signature.ts", "packages/shared/scripts/webhook-receiver.ts"] },
  { slug: "events", title: "Events", group: "Delivery", description: "POST /events request fields, responses and large payload handling.", keywords: "ingestion payload 201 validation s3 outbox", sources: ["packages/api/src/routes/events.ts", "packages/api/src/controllers/events.ts", "packages/api/src/services/events.ts"] },
  { slug: "webhook-endpoints", title: "Webhook endpoints", group: "Delivery", description: "Configure RECEIVER_URL and handle signed delivery envelopes.", keywords: "destination receiver url timeout http endpoint", sources: ["packages/worker/src/index.ts", "packages/worker/src/delivery/http.ts", "packages/shared/scripts/webhook-receiver.ts"] },
  { slug: "retries-dead-letters", title: "Retries and dead letters", group: "Delivery", description: "Backoff, circuit breaking, archived failures and explicit replay.", keywords: "retry failed recovery replay idempotency sqs visibility jitter", sources: ["packages/worker/src/delivery/backoff.ts", "packages/worker/src/index.ts", "packages/api/src/routes/dead-letters.ts", "packages/api/src/services/replays.ts"] },
  { slug: "multi-tenancy", title: "Multi-tenancy", group: "System", description: "Independent tenant budgets and bounded dispatch turns.", keywords: "fairness rate limit token bucket noisy neighbor tenant isolation", sources: ["packages/api/src/rate-limit.ts", "packages/worker/src/repositories/outbox.ts", "packages/worker/src/delivery/tenant-turns.ts"] },
  { slug: "architecture", title: "Architecture", group: "System", description: "Follow the transactional outbox, poller, queue and worker path.", keywords: "postgres postgresql sqs s3 redis advisory lock at least once", sources: ["docs/waybill-architecture.md", "packages/worker/src/outbox-poller.ts", "packages/worker/src/index.ts"] },
  { slug: "delivery-history", title: "Delivery history", group: "System", description: "Read delivery states, summaries and archives through the replica.", keywords: "observability tracking pagination cursor status metrics replica lag", sources: ["docs/PHASE_7_NOTES.md", "packages/api/src/routes/delivery-history.ts", "packages/api/src/repositories/delivery-history.ts"] },
  { slug: "configuration", title: "Configuration", group: "System", description: "Configure local processes, read replicas and worker defaults.", keywords: "environment env database aws redis receiver setup replica tuning", sources: [".env.example", "docker-compose.yml", "docs/PHASE_7_NOTES.md", "docs/project-guide.md"] },
] as const;

export type DocTopic = typeof DOC_TOPICS[number];
export type DocSlug = DocTopic["slug"];
export const DOC_GROUPS = ["Start here", "Delivery", "System"] as const;

export function docsHref(slug: DocSlug): string {
  return slug === "introduction" ? "/docs" : `/docs/${slug}`;
}

export function findDocTopic(slug: string): DocTopic | undefined {
  return DOC_TOPICS.find(topic => topic.slug === slug);
}

export function searchDocs(query: string): readonly DocTopic[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return DOC_TOPICS.filter(topic => {
    const text = `${topic.title} ${topic.description} ${topic.keywords}`.toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export const DOC_CODE = {
  prepare: "bun install\ncp .env.example .env",
  database: "docker compose up -d postgres redis\nbunx prisma@5.22.0 migrate deploy --schema packages/shared/prisma/schema.prisma\nbun run prisma:generate\nbun run seed:tenant",
  tenant: `docker compose exec -T postgres psql -U webhook -d webhook_platform \\\n  -c "SELECT id, hmac_secret FROM tenants WHERE name = 'dev-tenant';"`,
  receiver: "RECEIVER_URL=http://127.0.0.1:4000/webhook\nRECEIVER_TENANT_ID=REPLACE_WITH_TENANT_UUID\nRECEIVER_HMAC_SECRET=REPLACE_WITH_THAT_TENANTS_SECRET",
  health: "curl --max-time 10 http://127.0.0.1:3000/health",
  history: `curl --fail-with-body --max-time 15 \\\n  'http://127.0.0.1:3000/tenants/REPLACE_WITH_TENANT_UUID/deliveries?status=FAILED&limit=20'`,
  summary: `curl --fail-with-body --max-time 15 \\\n  'http://127.0.0.1:3000/tenants/REPLACE_WITH_TENANT_UUID/deliveries/summary'`,
  deadLetters: `curl --fail-with-body --max-time 15 \\\n  'http://127.0.0.1:3000/tenants/REPLACE_WITH_TENANT_UUID/dead-letters?limit=20'`,
  payload: `curl --fail-with-body --max-time 20 \\\n  'http://127.0.0.1:3000/tenants/REPLACE_WITH_TENANT_UUID/dead-letters/REPLACE_WITH_DEAD_LETTER_UUID/payload'`,
  replay: `curl --fail-with-body --max-time 20 \\\n  --request POST \\\n  'http://127.0.0.1:3000/tenants/REPLACE_WITH_TENANT_UUID/dead-letters/REPLACE_WITH_DEAD_LETTER_UUID/replay' \\\n  --header 'Idempotency-Key: REPLACE_WITH_REQUEST_UUID' \\\n  --header 'Content-Type: application/json' \\\n  --data '{}'`,
  replica: "bun run setup:replica",
  replicaUrl: "READ_REPLICA_DATABASE_URL=postgresql://waybill_reader:local-reader-only@127.0.0.1:15433/webhook_platform",
} as const;
