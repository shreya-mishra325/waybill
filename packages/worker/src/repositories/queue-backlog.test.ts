import { expect, test } from "bun:test";
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { parseQueueDepth, readQueueBacklog } from "./queue-backlog";

const attributes = { ApproximateNumberOfMessages: "3", ApproximateNumberOfMessagesNotVisible: "2", ApproximateNumberOfMessagesDelayed: "0" };

test("queue sampling validates all counts and never replaces absent values with zero", () => {
  expect(parseQueueDepth(attributes)).toEqual({ visible: 3, in_flight: 2, delayed: 0 });
  expect(() => parseQueueDepth(undefined)).toThrow();
  expect(() => parseQueueDepth({ ApproximateNumberOfMessages: "1" })).toThrow();
  for (const invalid of ["", "-1", "1.5", "NaN", "Infinity", "1e3", " 2", "9007199254740992"]) {
    expect(() => parseQueueDepth({ ...attributes, ApproximateNumberOfMessages: invalid })).toThrow();
  }
});

test("queue sampling uses only GetQueueAttributes and propagates its deadline signal", async () => {
  const client = new SQSClient({ region: "ap-southeast-2" });
  const controller = new AbortController();
  let calls = 0;
  client.send = (async (command: GetQueueAttributesCommand, options: { abortSignal: AbortSignal }) => {
    calls++;
    expect(command).toBeInstanceOf(GetQueueAttributesCommand);
    expect(command.input.AttributeNames).toEqual(["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"]);
    expect(options.abortSignal).toBe(controller.signal);
    return { Attributes: attributes };
  }) as typeof client.send;
  try {
    expect(await readQueueBacklog(client, "https://sqs.example.invalid/test", controller.signal)).toEqual({ visible: 3, in_flight: 2, delayed: 0 });
    controller.abort(new Error("sampling deadline"));
    await expect(readQueueBacklog(client, "https://sqs.example.invalid/test", controller.signal)).rejects.toThrow("sampling deadline");
    expect(calls).toBe(1);
  } finally { client.destroy(); }
});

test("queue sampling rejects a response that arrives after cancellation", async () => {
  const client = new SQSClient({ region: "ap-southeast-2" });
  const controller = new AbortController();
  client.send = (async () => {
    controller.abort(new Error("sampling deadline"));
    return { Attributes: attributes };
  }) as typeof client.send;
  try {
    await expect(readQueueBacklog(client, "https://sqs.example.invalid/test", controller.signal)).rejects.toThrow("sampling deadline");
  } finally { client.destroy(); }
});
