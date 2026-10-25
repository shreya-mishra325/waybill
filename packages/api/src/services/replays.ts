import { Prisma } from "@waybill/shared";
import { ArchiveNotFoundError, readArchivedPayload } from "../repositories/archived-payloads";
import { createReplay, findReplayByKey, findReplaySource } from "../repositories/replays";
import { InvalidArchiveError } from "./archive-json";
import { ArchivedPayloadGoneError, ArchivedPayloadInvalidError, DeadLetterNotFoundError,
  DeadLetterUnavailableError } from "./dead-letters";
import { parseReplayQuery, ReplayConflictError } from "./replay-query";

type ReplayRecord = NonNullable<Awaited<ReturnType<typeof findReplayByKey>>>;

function response(replay: ReplayRecord, deadLetterId: string) {
  if (replay.sourceDeadLetterId !== deadLetterId) throw new ReplayConflictError("Idempotency key is already used for another dead-letter record");
  return { replayId: replay.id, deadLetterId: replay.sourceDeadLetterId,
    originalEventId: replay.sourceDeadLetter.eventId, eventId: replay.eventId, createdAt: replay.createdAt };
}

export async function requestReplay(tenantId: unknown, deadLetterId: unknown, idempotencyKey: unknown,
  body: unknown, query: unknown) {
  const input = parseReplayQuery(tenantId, deadLetterId, idempotencyKey, body, query);
  try {
    const existing = await findReplayByKey(input.tenantId, input.idempotencyKey);
    if (existing) return response(existing, input.deadLetterId);
    const source = await findReplaySource(input.tenantId, input.deadLetterId);
    if (!source) throw new DeadLetterNotFoundError("Dead-letter record not found");
    if (source.delivery.status !== "DEAD_LETTERED") throw new ReplayConflictError("Only a dead-lettered delivery can be replayed");
    if (source.replay) throw new ReplayConflictError("This dead-letter record already has a replay");
    const targetUrl = process.env.RECEIVER_URL;
    if (!targetUrl) throw new Error("RECEIVER_URL is required for replay");
    if (source.targetUrl !== targetUrl) throw new ReplayConflictError("Replay destination must match the configured receiver");
    await readArchivedPayload(source.payloadS3Key);
    try {
      const result = await createReplay({ ...input, archiveKey: source.payloadS3Key, targetUrl });
      if (result.kind === "missing") throw new DeadLetterNotFoundError("Dead-letter record not found");
      if (result.kind === "conflict") throw new ReplayConflictError("Source delivery changed; reload before replaying");
      return response(result.replay, input.deadLetterId);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const repeated = await findReplayByKey(input.tenantId, input.idempotencyKey);
        if (repeated) return response(repeated, input.deadLetterId);
        throw new ReplayConflictError("This dead-letter record already has a replay");
      }
      throw error;
    }
  } catch (cause) {
    if (cause instanceof ReplayConflictError || cause instanceof DeadLetterNotFoundError) throw cause;
    if (cause instanceof ArchiveNotFoundError) throw new ArchivedPayloadGoneError("Archived payload is no longer available", {cause});
    if (cause instanceof InvalidArchiveError) throw new ArchivedPayloadInvalidError("Archived payload cannot be replayed", {cause});
    throw new DeadLetterUnavailableError(cause);
  }
}
