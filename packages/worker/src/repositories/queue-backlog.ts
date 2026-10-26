import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { validateBacklogCount, type QueueDepth } from "@waybill/shared";

export function parseQueueDepth(attributes: Record<string, string | undefined> | undefined): QueueDepth {
  function count(key: string): number {
    const value = attributes?.[key];
    if (value === undefined || !/^\d+$/.test(value)) throw new Error(`Missing or invalid SQS backlog attribute: ${key}`);
    return validateBacklogCount(Number(value));
  }
  return {
    visible: count("ApproximateNumberOfMessages"),
    in_flight: count("ApproximateNumberOfMessagesNotVisible"),
    delayed: count("ApproximateNumberOfMessagesDelayed"),
  };
}

export async function readQueueBacklog(sqs: SQSClient, queueUrl: string, signal: AbortSignal): Promise<QueueDepth> {
  signal.throwIfAborted();
  const result = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"],
  }), { abortSignal: signal });
  signal.throwIfAborted();
  return parseQueueDepth(result.Attributes);
}
