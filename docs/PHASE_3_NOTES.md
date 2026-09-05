# Phase 3 - Retries, backoff, and dead letters

Phase 2 delivered once and deleted the SQS message on success. Phase 3 keeps a failed message until it either succeeds or is exhausted, then archives it.

## What I shipped

- Exponential backoff with full jitter: `random(0, min(1000 * 2^(n-1), 60000))`.
- On failure, `deliveries.nextAttemptAt` is set and SQS visibility is changed to match. The message is not deleted.
- If SQS redelivers before `nextAttemptAt`, the worker hides the message again and does not increment `attemptCount`.
- After `MAX_DELIVERY_ATTEMPTS` (default 8), the payload is archived to S3, a `dead_letters` row is written, the delivery is marked `DEAD_LETTERED`, and then the SQS message is deleted.
- Small payloads that never went through claim-check are written to `dead-letters/{eventId}.json`. Existing `payloadS3Key` values are reused.

## Verified

Happy path still works. Receiver up, two events POSTed, poller published, worker logged `delivery succeeded`, receiver logged `webhook received`.

Backoff: receiver stopped, one more event POSTed. Worker logged `scheduled retry` with `attemptCount` 1 through 7 and a growing `nextAttemptAt` (about 4s, then 8s, then ~47s of hide time, jittered).

Dead letter: after the cutoff, worker logged `delivery dead-lettered` for `36a017f4-c798-42ab-b467-56474bb11222`. `dead_letters` has the row. Delivery status is `DEAD_LETTERED`. S3 has `dead-letters/36a017f4-c798-42ab-b467-56474bb11222.json`.

That event was already on attempt 7 when the cutoff code landed, so the archived `attemptCount` is 9 (one more retry, then one increment after the worker reload). A fresh event dead-letters on attempt 8.

## What I learned

**Failure must not delete the queue message.**
Delete-on-fail is a silent drop. Leave the message, hide it until the next attempt, and only delete after a 200 or after a durable dead-letter write. If the worker dies mid-POST, visibility expires and another worker can take it. That is at-least-once, not at-most-once.

**Visibility timeout is the retry clock.**
SQS has no "deliver at T". `ChangeMessageVisibility` is how we sleep without a second scheduler. `nextAttemptAt` in Postgres is the source of truth. If the message shows up early, hide it again. Do not count that as an attempt. Counting early receives would burn the budget on clock skew, not on real POSTs.

**Full jitter beats a fixed exponential.**
`min(1000 * 2^(n-1), 60000)` is the cap. Sleep is random in `[0, cap]`. If every worker uses the same delay, they all wake together and stampede the sick endpoint. Randomizing the sleep spreads the load. AWS published this as "full jitter."

**Dead-letter in Postgres, payload in S3.**
An SQS redrive policy would hide the failure in another queue. We need a row we can query, a last error, and a payload we can replay from the dashboard later. The queue's job is "do not lose the in-flight message." The dead-letter table's job is "this one is done failing, a human can look at it."

**Write the archive before you delete SQS.**
Order is: PutObject if needed, insert `dead_letters`, mark `DEAD_LETTERED`, then `DeleteMessage`. If S3 or Postgres fails, the message stays visible later and we try again. Delete first and a crash loses the payload.

**`attemptCount` increments only when a real attempt starts.**
`upsertInFlight` bumps the counter, then we POST (or load payload). A hide-until-due path never reaches that increment. Exhausted means `attemptCount >= MAX_DELIVERY_ATTEMPTS` after a real failure, not after a premature receive.

## Checkpoint

| Check | Result |
|---|---|
| Failed delivery stays in SQS and `nextAttemptAt` grows | yes |
| Early redelivery does not increment `attemptCount` | yes (hide path) |
| After N failures, `dead_letters` row + S3 object + SQS delete | yes |
| Success path still deletes SQS only after HTTP 200 | yes |
