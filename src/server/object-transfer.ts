import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import { env } from "./env";
import { listObjects, putObject, storage } from "./storage";
// A copy of the objects of the storage in a directory and back, for the backup of a
// deployment: the files go under `objects/<key>` and `manifest.jsonl` lists every key with
// its size, type and SHA-256, so that a restore can tell a file that was damaged or cut off
// from one that is whole. It speaks the S3 API, so it works for any storage behind it.
const entry = z.object({
  key: z.string().min(1),
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.string(),
});
export type ManifestEntry = z.infer<typeof entry>;
// A key becomes a path inside the directory; one that would leave it is refused.
function place(directory: string, key: string): string {
  const target = path.resolve(directory, "objects", key);
  const root = path.resolve(directory, "objects") + path.sep;
  if (key.startsWith("/") || key.split("/").includes("..") || !target.startsWith(root))
    throw new Error("object_key_unsafe");
  return target;
}
export async function exportObjects(
  directory: string,
  options: { prefix?: string } = {},
): Promise<{ objects: number; bytes: number }> {
  await mkdir(path.join(directory, "objects"), { recursive: true });
  const lines: string[] = [];
  let bytes = 0;
  for await (const object of listObjects(options.prefix)) {
    const result = await storage().send(
      new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: object.key }),
    );
    if (!result.Body) throw new Error("object_empty");
    const content = Buffer.from(await result.Body.transformToByteArray());
    const target = place(directory, object.key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    bytes += content.length;
    lines.push(
      JSON.stringify({
        key: object.key,
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        contentType: result.ContentType ?? "application/octet-stream",
      } satisfies ManifestEntry),
    );
  }
  // Written last: a directory without a manifest is a copy that did not finish.
  await writeFile(
    path.join(directory, "manifest.jsonl"),
    lines.map((line) => `${line}\n`).join(""),
  );
  return { objects: lines.length, bytes };
}
export async function importObjects(
  directory: string,
): Promise<{ objects: number; bytes: number }> {
  const manifest = (await readFile(path.join(directory, "manifest.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => entry.parse(JSON.parse(line)));
  // Every file is checked before the first one is written, so that a damaged copy
  // changes nothing.
  const contents = new Map<string, Buffer>();
  let bytes = 0;
  for (const item of manifest) {
    const content = await readFile(place(directory, item.key));
    if (
      content.length !== item.size ||
      createHash("sha256").update(content).digest("hex") !== item.sha256
    )
      throw new Error(`object_damaged:${item.key}`);
    contents.set(item.key, content);
    bytes += content.length;
  }
  for (const item of manifest)
    await putObject(item.key, contents.get(item.key) ?? Buffer.alloc(0), item.contentType);
  return { objects: manifest.length, bytes };
}
