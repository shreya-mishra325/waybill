# Phase 2 - Outbox poller, worker, and leader election

Phase 1 stored the intent. Phase 2 turns that intent into a real HTTP POST. The API still does not talk to SQS.

## What I shipped

- A test receiver on port 4000 that stands in for a tenant webhook.
- An outbox poller that reads `published = false`, `SendMessage`s to SQS, then marks the row published.
- A delivery worker that long-polls SQS, resolves inline or S3 payloads, POSTs to `RECEIVER_URL`, and deletes the SQS message only after a successful POST.
- Leader election for the poller via `pg_try_advisory_lock` on a single Postgres connection.

## What I learned

**The outbox is a durable "to-do" list, not a queue.**
Postgres is the source of truth for "this event must be published." SQS is how workers scale and survive crashes. If SQS is down, the API can still return 201. The poller keeps trying until `SendMessage` succeeds.

**Delete the SQS message only after the tenant POST succeeds.**
Delete-then-POST can lose the event if the process dies. POST-then-delete can deliver twice if the delete never happens. SQS is at-least-once. Duplicates are the cost of not losing work. Phase 3 will add backoff. Phase 2 only proves the pipe.

**Long poll and visibility timeout are two different clocks.**
`WaitTimeSeconds: 20` avoids empty receive loops. `VisibilityTimeout: 30` hides a message while this worker POSTs. If the worker dies, the timeout expires and another worker can take the message.

**Claim-check is resolved on consume.**
The queue message may hold only `payloadS3Key`. The worker fetches the object, then POSTs the real JSON. The tenant does not speak our pointer format.

**Two pollers without a lock will double-publish.**
Both see `published = false`, both call `SendMessage`, both try to mark published. The tenant gets two HTTP calls. `updateMany` where `published = false` does not prevent the two sends. The send happens before the update.

**Advisory locks are leader election with a Postgres primitive.**
`pg_try_advisory_lock(728401)` is session-scoped. The instance that gets `true` polls. The other loops as standby. If the leader process dies, the session ends and Postgres releases the lock. The standby becomes leader. That is the same idea as Raft (one active coordinator, automatic failover) without a consensus library.

**The lock must live on one connection.**
Prisma's default pool can take the lock on connection A and run the next query on connection B. The lock stays on A until A closes, which can happen on idle timeout. The poller uses `connection_limit=1` so the lock and the outbox queries share one session.

**What breaks if two processes both think they are leader.**
Each would publish the same outbox row to SQS. The worker would POST twice. `published` would still flip to true. You would not see an error in Postgres. You would see duplicate webhook calls. Interviewers probe this: the lock is not "nice to have," it is the uniqueness of the publisher.

## Checkpoint

| Check | Result |
|---|---|
| Test receiver | `POST /webhook` returns `{ ok: true }` |
| Poller | Unpublished outbox becomes an SQS message |
| Worker | Receiver logs the body, delivery `SUCCEEDED`, SQS message deleted |
| Two pollers | One logs `became leader`, the other logs `standby` |

To verify the lock: run `bun run dev:poller` in two terminals, then `bun run post:event`. Only one poller should log `outbox published`.
