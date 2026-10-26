import type { Message } from "@aws-sdk/client-sqs";

export type Acknowledge = () => Promise<void>;

export class DeliveryConfirmations {
  private readonly pending = new Set<Promise<void>>();
  private readonly callbackErrors: unknown[] = [];

  constructor(private readonly limit = 10) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Confirmation limit must be a positive integer");
  }

  async schedule(message: Message, acknowledge: Acknowledge, onError: (message: Message, error: unknown) => void): Promise<void> {
    while (this.pending.size >= this.limit) await Promise.race(this.pending);
    const task = Promise.resolve().then(acknowledge).catch((error: unknown) => {
      try { onError(message, error); }
      catch (callbackError) { this.callbackErrors.push(callbackError); }
    }).finally(() => { this.pending.delete(task); });
    this.pending.add(task);
  }

  async drain(): Promise<void> {
    await Promise.all(this.pending);
    if (this.callbackErrors.length) throw new AggregateError(this.callbackErrors, "Confirmation error callback failed");
  }
}

export async function processDeliveryBatch(
  messages: Message[],
  handle: (message: Message) => Promise<Acknowledge | void>,
  onError: (message: Message, error: unknown) => void,
  sharedConfirmations?: DeliveryConfirmations,
): Promise<void> {
  const confirmations = sharedConfirmations ?? new DeliveryConfirmations();
  try {
    for (const message of messages) {
      try {
        const acknowledge = await handle(message);
        if (acknowledge) await confirmations.schedule(message, acknowledge, onError);
      } catch (error) { onError(message, error); }
    }
  } finally {
    if (!sharedConfirmations) await confirmations.drain();
  }
}
