export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
export class InvalidArchiveError extends Error {}

export async function readArchiveJson(
  stream: ReadableStream<Uint8Array>, signal: AbortSignal, contentLength?: number,
): Promise<unknown> {
  const reader = stream.getReader();
  let complete = false;
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Archive read deadline exceeded"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    if (contentLength !== undefined && contentLength > MAX_ARCHIVE_BYTES) {
      throw new InvalidArchiveError("Archive exceeds the inspection size limit");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (chunk.done) { complete = true; break; }
      size += chunk.value.byteLength;
      if (size > MAX_ARCHIVE_BYTES) throw new InvalidArchiveError("Archive exceeds the inspection size limit");
      chunks.push(chunk.value);
    }
    try {
      const bytes = Buffer.concat(chunks, size);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (cause) {
      throw new InvalidArchiveError("Archive is not valid UTF-8 JSON", { cause });
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (complete) reader.releaseLock();
    else void reader.cancel().catch((error: unknown) => {
      console.error("Archive stream cancellation failed", { type: error instanceof Error ? error.name : "unknown" });
    });
  }
}
