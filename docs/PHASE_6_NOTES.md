# Phase 6 - Webhook signatures

The worker could deliver events, but the receiver had no way to verify where a request came from or whether its body had changed. I added HMAC-SHA256 signing with the existing per-tenant `hmacSecret` and verification in the example receiver.

## Signing the request

The signature header is:

```text
X-Waybill-Signature: sha256=<64 lowercase hexadecimal characters>
```

The input to HMAC is the exact HTTP body, including the event ID, tenant ID, event type, and resolved payload. `postWebhook` serializes that envelope once, signs the resulting string, and sends the same string. For S3-backed events, payload retrieval happens before serialization and signing. Signing the SQS pointer would not authenticate the body received by the webhook endpoint.

`repositories/tenants.ts` reads only `hmacSecret` for the queued tenant ID. The lookup has a 5-second transaction acquisition limit and a 10-second execution limit. Each attempt reads the secret again. An unavailable tenant or empty secret fails preparation and follows the existing retry/dead-letter path. The worker does not send an unsigned request when secret lookup fails.

HTTP calls keep the existing 10-second timeout. Receiver errors still go through the normal delivery failure handling.

## Verifying the body

The receiver reads the raw bytes and verifies the signature before parsing JSON. Parsing and reserializing first can change whitespace, property order, or Unicode representation, even when the JSON has the same meaning.

Verification rejects missing headers, malformed digests, and empty secrets. It decodes the expected and supplied digests and uses `timingSafeEqual` to compare them. The strict header format ensures both buffers have the same length before comparison.

The expected secret comes from receiver configuration, never from the request. After signature verification, the example receiver checks that the signed tenant ID matches its configured tenant. Secrets and signatures are not logged.

| Request | Response |
| --- | --- |
| Valid signature and configured tenant | 200 |
| Missing or invalid signature | 401 |
| Valid signature but unexpected tenant | 403 |
| Valid signature but invalid JSON | 400 |

Missing receiver configuration prevents startup.

## Local receiver setup

The example accepts one tenant. These values in `.env` must match that tenant's existing database record:

```text
RECEIVER_TENANT_ID=<tenant id>
RECEIVER_HMAC_SECRET=<same tenant's hmacSecret>
```

The values can be copied from the `Tenant` model in Prisma Studio:

```bash
bunx prisma@5.22.0 studio --schema packages/shared/prisma/schema.prisma
```

Use the `dev-tenant` row for the existing `post:event` script. If it does not exist, `bun run seed:tenant` creates it. The receiver secret is the database value, not the placeholder in `.env.example`. There is no shared default signing secret.

Start the receiver:

```bash
bun run dev:receiver
```

In another terminal, from the same repository:

```bash
bun run ping:receiver
```

The ping script signs its request. With matching settings, the response is `200 {"ok":true}`.

The Phase 5 fairness runner uses a separate receiver for generated test tenants. It measures arrival times and does not verify signatures. The single-tenant receiver here cannot replace that receiver for a fairness run.

## Tests

The helper tests include an independent RFC 4231 HMAC-SHA256 vector, body tampering, wrong tenant secrets, JSON whitespace and key-order changes, Unicode, oversized bodies, malformed headers, and empty secrets.

Local HTTP tests exercise `postWebhook` against the verification handler. Valid requests return 200; changed bodies, missing signatures, and wrong secrets return 401. They also cover a 300 KB payload envelope and repeated delivery. These tests cover the HTTP boundary; S3 retrieval and SQS delivery were checked separately below.

At the end of Phase 6, `bun test` passed 33 tests, with one opt-in PostgreSQL test skipped. API, worker, shared, and script TypeScript checks passed.

## Full delivery test: 2026-10-25

Two events went through the local API, database outbox, existing AWS queue, worker, and verifying receiver. The queue and pending outbox were empty before the test. The receiver used the development tenant's existing secret.

| Event | Storage | Signature | Delivery | Attempts |
| --- | --- | --- | --- | --- |
| `34df921a-1679-404c-92ca-939967bc293e` | PostgreSQL inline | Accepted | SUCCEEDED | 1 |
| `fc563545-c28d-48f4-8613-2d9c485197d6` | S3, 270 KB blob | Accepted | SUCCEEDED | 1 |

Both outbox records were published, and both deliveries succeeded on the first attempt. A separate request with its body changed after signing returned 401. The queue and outbox were empty after delivery. The test records remain in the development database, and the large payload remains in S3.

This checked normal signed delivery and S3 payload reconstruction. It did not test recovery during an AWS outage.

## What I learned

The signature belongs to the transmitted bytes, not the parsed JSON object. Serializing once in the sender and verifying before parsing in the receiver keeps both sides working with the same input.

Signing and duplicate handling solve different problems. The current format has no timestamp, so a captured valid request can be sent again with the same signature. Receivers still need duplicate handling by event ID. Timestamp validation and key-rotation overlap are not implemented.

A shared queue can carry events for many tenants, but each delivery must use that tenant's secret. The example receiver accepts one configured tenant; the worker still uses a single configured destination URL. Per-tenant destination configuration remains separate work.

References: [Node crypto API](https://nodejs.org/api/crypto.html), [RFC 4231](https://www.rfc-editor.org/rfc/rfc4231.html).
