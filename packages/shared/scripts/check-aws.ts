import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { createS3Client, createSqsClient } from "../src/aws";

const TIMEOUT_MS = 8000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function sendWithTimeout<T>(
  send: (abortSignal: AbortSignal) => Promise<T>,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await send(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const queueUrl = requireEnv("SQS_QUEUE_URL");
  const bucket = requireEnv("S3_BUCKET_NAME");
  const sqs = createSqsClient();
  const s3 = createS3Client();

  await sendWithTimeout(
    (abortSignal) =>
      sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: ["QueueArn"],
        }),
        { abortSignal },
      ),
    "SQS GetQueueAttributes",
  );
  console.log("SQS reachable", { queueUrl });

  await sendWithTimeout(
    (abortSignal) =>
      s3.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal }),
    "S3 HeadBucket",
  );
  console.log("S3 reachable", { bucket });
}

main().catch((err: unknown) => {
  console.error("AWS check failed", err);
  process.exit(1);
});
