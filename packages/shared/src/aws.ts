import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

let sqsClient: SQSClient | undefined;

export function createSqsClient(): SQSClient {
  sqsClient ??= new SQSClient({ region: requireEnv("AWS_REGION") });
  return sqsClient;
}

export function createS3Client(): S3Client {
  return new S3Client({ region: requireEnv("AWS_REGION") });
}
