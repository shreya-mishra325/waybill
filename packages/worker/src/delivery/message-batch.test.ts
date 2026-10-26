import { describe, expect, it } from "bun:test";
import { DeliveryConfirmations, processDeliveryBatch } from "./message-batch";

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


describe("receive-cycle confirmations", () => {
  it("continues across receive batches, caps pending deletes, and drains before completion", async () => {
    const confirmations = new DeliveryConfirmations(2);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const second = new Promise<void>(resolve => { releaseSecond = resolve; });
    const deleting: string[] = [];
    let active = 0;
    let maximum = 0;
    let thirdHandled!: () => void;
    const third = new Promise<void>(resolve => { thirdHandled = resolve; });
    const handle = async (message: { MessageId?: string }) => {
      if (message.MessageId === "three") thirdHandled();
      return async () => {
        active++;
        maximum = Math.max(maximum, active);
        deleting.push(message.MessageId!);
        if (message.MessageId === "one") await first;
        if (message.MessageId === "two") await second;
        active--;
      };
    };
    const onError = (_message: unknown, error: unknown) => { throw error; };
    await processDeliveryBatch([{ MessageId: "one" }], handle, onError, confirmations);
    await processDeliveryBatch([{ MessageId: "two" }], handle, onError, confirmations);
    const nextBatch = processDeliveryBatch([{ MessageId: "three" }], handle, onError, confirmations);
    await third;
    expect(deleting).toEqual(["one", "two"]);
    expect(active).toBe(2);
    releaseFirst();
    await nextBatch;
    expect(deleting).toEqual(["one", "two", "three"]);
    expect(maximum).toBe(2);
    let drained = false;
    const drain = confirmations.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseSecond();
    await drain;
    expect(drained).toBe(true);
    expect(active).toBe(0);
  });

  it("reports a failed delete once without dropping later batches", async () => {
    const confirmations = new DeliveryConfirmations();
    const failures: string[] = [];
    const completed: string[] = [];
    await processDeliveryBatch([{ MessageId: "failed" }], async () => async () => { throw new Error("delete unavailable"); },
      message => { failures.push(message.MessageId!); }, confirmations);
    await processDeliveryBatch([{ MessageId: "later" }], async message => async () => { completed.push(message.MessageId!); },
      message => { failures.push(message.MessageId!); }, confirmations);
    await confirmations.drain();
    expect(failures).toEqual(["failed"]);
    expect(completed).toEqual(["later"]);
    expect(() => new DeliveryConfirmations(0)).toThrow();
  });
});
