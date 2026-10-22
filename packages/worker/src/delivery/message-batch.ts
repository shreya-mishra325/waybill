import type { Message } from "@aws-sdk/client-sqs";

export type Acknowledge = () => Promise<void>;

export async function processDeliveryBatch(
  messages: Message[],
  handle: (message: Message) => Promise<Acknowledge | void>,
  onError: (message: Message, error: unknown) => void,
): Promise<void> {
  const acknowledgements: Promise<void>[] = [];
  for (const message of messages) {
    try {
      const acknowledge = await handle(message);
      if (acknowledge) {
        acknowledgements.push(acknowledge().catch((err: unknown) => onError(message, err)));
      }
    } catch (err) {
      onError(message, err);
    }
  }
  await Promise.all(acknowledgements);
}
