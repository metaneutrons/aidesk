import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { sqlClient } from "../../../../server/db";
import { storage } from "../../../../server/storage";
import { env } from "../../../../server/env";
export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  try {
    await sqlClient()`select 1`;
    await storage().send(new HeadBucketCommand({ Bucket: env().S3_BUCKET }));
    return Response.json({ status: "ready" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
