import {
  S3Client,
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "./env";
export function storage(): S3Client {
  const config = env();
  return new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
  });
}
export async function initializeStorage(): Promise<void> {
  const client = storage();
  try {
    await client.send(new HeadBucketCommand({ Bucket: env().S3_BUCKET }));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "$metadata" in error &&
      (error as { $metadata: { httpStatusCode?: number } }).$metadata.httpStatusCode === 404
    ) {
      await client.send(new CreateBucketCommand({ Bucket: env().S3_BUCKET }));
    } else {
      throw error;
    }
  }
}

// Private objects such as original mail. Keys are content-addressed by the
// caller, so writing the same object twice is harmless.
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await storage().send(
    new PutObjectCommand({
      Bucket: env().S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}
export async function getObject(key: string): Promise<Buffer> {
  const result = await storage().send(new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }));
  if (!result.Body) throw new Error("object_empty");
  return Buffer.from(await result.Body.transformToByteArray());
}
