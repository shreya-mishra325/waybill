import { describe, expect, it } from "bun:test";
import { processDeliveryBatch } from "./message-batch";

describe("delivery batch", () => {
  it("delivers sequentially while confirmations overlap and waits for all confirmations", async () => {
    const events: string[] = [];
    let release: () => void = () => {};
    const confirmation = new Promise<void>((resolve) => { release = resolve; });
    let secondStarted: () => void = () => {};
    const second = new Promise<void>((resolve) => { secondStarted = resolve; });
    let finished = false;
    const run = processDeliveryBatch([{ MessageId: "one" }, { MessageId: "two" }], async (message) => {
      events.push(`deliver ${message.MessageId}`);
      await Promise.resolve();
      events.push(`persist ${message.MessageId}`);
      if (message.MessageId === "two") secondStarted();
      return async () => {
        events.push(`delete ${message.MessageId}`);
        await confirmation;
      };
    }, (_message, err) => { throw err; }).then(() => { finished = true; });
    await second;
    expect(events.slice(0, 5)).toEqual([
      "deliver one", "persist one", "delete one", "deliver two", "persist two",
    ]);
    expect(finished).toBe(false);
    release();
    await run;
    expect(finished).toBe(true);
    expect(events.at(-1)).toBe("delete two");
  });

  it("reports delivery and delete failures without dropping the rest of the batch", async () => {
    const handled: string[] = [];
    const failures: string[] = [];
    await processDeliveryBatch([
      { MessageId: "delivery-error" }, { MessageId: "delete-error" }, { MessageId: "success" },
    ], async (message) => {
      handled.push(message.MessageId!);
      if (message.MessageId === "delivery-error") throw new Error("HTTP failed");
      return async () => {
        if (message.MessageId === "delete-error") throw new Error("SQS failed");
      };
    }, (message) => { failures.push(message.MessageId!); });
    expect(handled).toEqual(["delivery-error", "delete-error", "success"]);
    expect(failures.sort()).toEqual(["delete-error", "delivery-error"]);
  });

  it("does not acknowledge deferred messages", async () => {
    let handled = 0;
    await processDeliveryBatch([{ MessageId: "deferred" }], async () => {
      handled++;
    }, (_message, err) => { throw err; });
    expect(handled).toBe(1);
  });
});
