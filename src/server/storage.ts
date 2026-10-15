import {
  S3Client,
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
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
      // Several processes may start on an empty store; the one that loses
      // the race finds the bucket already created, which is the goal.
      try {
        await client.send(new CreateBucketCommand({ Bucket: env().S3_BUCKET }));
      } catch (created) {
        const name = (created as { name?: unknown } | null)?.name;
        if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw created;
      }
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
export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}
// Every object of the bucket under a prefix, a page at a time.
export async function* listObjects(prefix = "", pageSize?: number): AsyncGenerator<StoredObject> {
  let token: string | undefined;
  do {
    const page = await storage().send(
      new ListObjectsV2Command({
        Bucket: env().S3_BUCKET,
        Prefix: prefix,
        ...(pageSize === undefined ? {} : { MaxKeys: pageSize }),
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? [])
      if (object.Key) {
        yield {
          key: object.Key,
          size: object.Size ?? 0,
          lastModified: object.LastModified ?? new Date(0),
        };
      }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}
// Up to a thousand keys in one request; the ones that could not be deleted are returned.
export async function deleteObjects(keys: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (let from = 0; from < keys.length; from += 1000) {
    const result = await storage().send(
      new DeleteObjectsCommand({
        Bucket: env().S3_BUCKET,
        Delete: {
          Objects: keys.slice(from, from + 1000).map((key) => ({ Key: key })),
          Quiet: true,
        },
      }),
    );
    for (const error of result.Errors ?? []) if (error.Key) failed.push(error.Key);
  }
  return failed;
}
