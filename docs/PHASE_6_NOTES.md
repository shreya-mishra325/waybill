# Phase 6: Webhook signatures

## Status

Worker signing and the example receiver are implemented. Local HTTP integration tests confirm that valid signatures are accepted and tampered bodies are rejected. A live smoke test also verified the API, outbox, SQS, worker, and receiver path, including an S3-backed payload.

## Signature format

- Algorithm: HMAC-SHA256 with the tenant's existing `hmacSecret`.
- Header: `X-Waybill-Signature: sha256=<64 lowercase hexadecimal characters>`.
- Input: the exact HTTP request body bytes. Serialize once, sign that serialization, and send the same bytes.
- Verification: reject missing or malformed headers, decode both digests, and compare with `timingSafeEqual`.
- An empty signing secret is a configuration error. Verification with an empty secret returns false.

JSON parsing and reserialization can change whitespace, property order, or Unicode representation. A receiver must retain the raw body for signature verification before processing the event. For S3-backed events, the worker must sign the final HTTP envelope after loading the payload, rather than the SQS pointer.

The receiver must resolve the expected secret from its own trusted configuration or tenant mapping. A request must never supply its own verification secret. Do not log signatures or tenant secrets.

This format authenticates the body but has no timestamp or replay protection. A captured valid request remains verifiable; receivers still need duplicate handling by event ID. Timestamp validation and key rotation are not implemented in this checkpoint.

## Validation

Tests cover an independent RFC 4231 test vector, valid signatures, tampering, wrong tenant secrets, JSON byte differences, Unicode, oversized bodies, malformed headers, and empty-secret rejection.

References: [Node crypto API](https://nodejs.org/api/crypto.html), [RFC 4231](https://www.rfc-editor.org/rfc/rfc4231.html).

## Worker integration

`repositories/tenants.ts` reads only `hmacSecret` for the queued tenant ID. The lookup uses a transaction with a 5-second acquisition deadline and a 10-second execution deadline. A missing tenant or empty secret fails delivery preparation and follows the existing bounded retry/dead-letter path; there is no unsigned fallback.

`postWebhook` serializes the complete HTTP envelope once, signs that string, and sends the same string with the signature header. The worker loads S3-backed payloads before this step. Each delivery attempt resolves the secret again. HTTP calls retain their 10-second deadline, and non-success responses retain the existing failure handling.

## Running the example receiver

Configure these values in your local environment, keeping the secret out of version control:

```text
RECEIVER_TENANT_ID=<existing development tenant ID>
RECEIVER_HMAC_SECRET=<that tenant record's hmacSecret>
```

The example deliberately accepts one configured tenant. Use the same tenant for `post:event`; ingestion creates events for an existing tenant and does not provision signing secrets. There is no global default secret. Configure the existing tenant secret rather than using the placeholder in `.env.example`.

```bash
bun run dev:receiver
```

From another terminal with the same environment:

```bash
bun run ping:receiver
```

The receiver verifies the raw request bytes before JSON parsing, then checks the signed tenant ID against its configured tenant. Missing or invalid signatures return 401; a signed unexpected tenant returns 403; invalid signed JSON returns 400. Missing receiver configuration prevents startup. The ping command now signs its request.

The Phase 5 fairness runner hosts its own multi-tenant measurement receiver. That receiver remains a latency test sink and does not validate signatures. It is not the Phase 6 verification example.

## Checkpoint results

- `bun test`: 33 passed, one opt-in PostgreSQL test skipped.
- API, worker, shared, and script TypeScript checks passed.
- Real local HTTP requests exercised the actual sender and receiver: valid signatures returned 200; body tampering, missing signatures, and a wrong secret returned 401.
- HTTP coverage includes Unicode, a 300 KB payload envelope, and repeated delivery. This does not exercise an actual S3 download or SQS retry.

## Live AWS smoke test

On 2026-10-25, two events were submitted through the local API and the existing AWS queue. The queue and pending outbox were empty before testing, and the receiver used the existing development tenant secret.

| Event | Storage | Receiver signature | Final delivery | Attempts |
| --- | --- | --- | --- | --- |
| `34df921a-1679-404c-92ca-939967bc293e` | PostgreSQL inline | Accepted | SUCCEEDED | 1 |
| `fc563545-c28d-48f4-8613-2d9c485197d6` | S3, 270 KB blob | Accepted | SUCCEEDED | 1 |

Both outbox records were published. A body modified after signing returned HTTP 401. Temporary API, publisher, worker, and receiver processes were stopped after verification; the existing Postgres and Redis services were left running. The smoke test records remain in the development database and the large payload remains in the configured S3 bucket.

This validates normal signed delivery and S3 payload reconstruction, not failure recovery under a live AWS outage. Timestamp-based replay rejection, secret rotation overlap, and per-tenant destination configuration remain outside this checkpoint.
