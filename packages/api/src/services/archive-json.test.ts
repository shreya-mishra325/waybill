import { expect, test } from "bun:test";
import { InvalidArchiveError, MAX_ARCHIVE_BYTES, readArchiveJson } from "./archive-json";

function stream(...parts: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const part of parts) controller.enqueue(part);
    controller.close();
  } });
}
const encode = (text: string) => new TextEncoder().encode(text);

test("archive JSON supports split Unicode bytes and null payloads", async () => {
  const bytes = encode('{"message":"नमस्ते 🌍"}');
  expect(await readArchiveJson(stream(bytes.slice(0, 14), bytes.slice(14)), new AbortController().signal))
    .toEqual({message: "नमस्ते 🌍"});
  expect(await readArchiveJson(stream(encode("null")), new AbortController().signal)).toBeNull();
});

test("archive JSON rejects invalid UTF-8, malformed JSON, and empty streams", async () => {
  for (const bytes of [new Uint8Array([255]), encode("{"), new Uint8Array()]) {
    await expect(readArchiveJson(stream(bytes), new AbortController().signal)).rejects.toBeInstanceOf(InvalidArchiveError);
  }
});

test("archive size limits apply to headers and actual downloaded bytes", async () => {
  let cancelled = false;
  const unread = new ReadableStream<Uint8Array>({cancel() { cancelled = true; }});
  await expect(readArchiveJson(unread, new AbortController().signal, MAX_ARCHIVE_BYTES + 1)).rejects.toThrow("size limit");
  expect(cancelled).toBe(true);
  await expect(readArchiveJson(stream(new Uint8Array(MAX_ARCHIVE_BYTES), encode("x")),
    new AbortController().signal, 1)).rejects.toThrow("size limit");
});

test("archive deadline cancels a stalled body, not just the initial response", async () => {
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({cancel() {cancelled = true;}});
  await expect(readArchiveJson(stalled, AbortSignal.timeout(20))).rejects.toThrow("deadline");
  expect(cancelled).toBe(true);
});

test("archive read honors an already-aborted request", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(readArchiveJson(stream(encode("null")), controller.signal)).rejects.toThrow();
});
