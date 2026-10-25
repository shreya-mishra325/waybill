import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client } from "@waybill/shared";
import { InvalidArchiveError, readArchiveJson } from "../services/archive-json";

export class ArchiveNotFoundError extends Error {}

export async function readArchivedPayload(key: string): Promise<unknown> {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) throw new Error("S3_BUCKET_NAME is required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const object = await createS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: controller.signal });
    if (!object.Body) throw new InvalidArchiveError("Archive body is missing");
    return await readArchiveJson(object.Body.transformToWebStream(), controller.signal, object.ContentLength);
  } catch (error) {
    if (error instanceof Error && error.name === "NoSuchKey") {
      throw new ArchiveNotFoundError("Archived payload no longer exists", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
