import { findDeadLetterArchive, listDeadLetters } from "../repositories/dead-letters";
import { ArchiveNotFoundError, readArchivedPayload } from "../repositories/archived-payloads";
import { InvalidArchiveError } from "./archive-json";
import { deadLetterCursor, parseDeadLetterPayloadQuery, parseDeadLetterQuery } from "./dead-letter-query";

export class DeadLetterNotFoundError extends Error {}
export class ArchivedPayloadGoneError extends Error {}
export class ArchivedPayloadInvalidError extends Error {}
export class DeadLetterUnavailableError extends Error {
  constructor(cause: unknown) { super("Dead-letter data is temporarily unavailable", { cause }); }
}

export async function getDeadLetters(tenantId: unknown, input: unknown) {
  const query = parseDeadLetterQuery(tenantId, input);
  let rows: Awaited<ReturnType<typeof listDeadLetters>>;
  try { rows = await listDeadLetters(query); }
  catch (cause) { throw new DeadLetterUnavailableError(cause); }
  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > query.limit && last ? deadLetterCursor(query, last) : null };
}

export async function getDeadLetterPayload(tenantId: unknown, deadLetterId: unknown, input: unknown) {
  const query = parseDeadLetterPayloadQuery(tenantId, deadLetterId, input);
  let archive: Awaited<ReturnType<typeof findDeadLetterArchive>>;
  try { archive = await findDeadLetterArchive(query.tenantId, query.deadLetterId); }
  catch (cause) { throw new DeadLetterUnavailableError(cause); }
  if (!archive) throw new DeadLetterNotFoundError("Dead-letter record not found");
  let payload: unknown;
  try { payload = await readArchivedPayload(archive.payloadS3Key); }
  catch (cause) {
    if (cause instanceof ArchiveNotFoundError) throw new ArchivedPayloadGoneError("Archived payload is no longer available", { cause });
    if (cause instanceof InvalidArchiveError) throw new ArchivedPayloadInvalidError("Archived payload cannot be inspected", { cause });
    throw new DeadLetterUnavailableError(cause);
  }
  return { deadLetterId: archive.id, tenantId: archive.tenantId, eventId: archive.eventId, payload };
}
