import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportObjects, importObjects } from "../src/server/object-transfer";
import { deleteObjects, getObject, initializeStorage, putObject } from "../src/server/storage";
// The copy of the objects for a backup: complete, checked on the way back, and unable to
// write outside its directory.
const prefix = `transfer-${randomUUID()}/`;
const key = (name: string) => `${prefix}${name}`;
const objects: Record<string, { body: Buffer; type: string }> = {
  "inbound/p/a.eml": {
    body: Buffer.from("From: a@example.test\r\n\r\nHello"),
    type: "message/rfc822",
  },
  "attachments/p/b": { body: Buffer.from([0, 1, 2, 250, 251]), type: "application/octet-stream" },
  "attachments/p/empty": { body: Buffer.alloc(0), type: "text/plain" },
};
const directories: string[] = [];
const fresh = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "transfer-"));
  directories.push(directory);
  return directory;
};
const put = async () => {
  for (const [name, { body, type }] of Object.entries(objects))
    await putObject(key(name), body, type);
};
beforeAll(async () => {
  await initializeStorage();
  await put();
}, 60_000);
afterAll(async () => {
  await deleteObjects(Object.keys(objects).map(key));
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});
describe("the copy of the objects of the storage", () => {
  it("writes every object under its key with a manifest of size, type and SHA-256", async () => {
    const directory = await fresh();
    const result = await exportObjects(directory, { prefix });
    expect(result).toEqual({
      objects: 3,
      bytes: Object.values(objects).reduce((sum, { body }) => sum + body.length, 0),
    });
    expect(await readFile(path.join(directory, "objects", key("attachments/p/b")))).toEqual(
      objects["attachments/p/b"]?.body,
    );
    const manifest = (await readFile(path.join(directory, "manifest.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { key: string; contentType: string; sha256: string });
    expect(manifest.map((item) => item.key).sort()).toEqual(Object.keys(objects).map(key).sort());
    expect(manifest.find((item) => item.key === key("inbound/p/a.eml"))?.contentType).toBe(
      "message/rfc822",
    );
    expect(manifest.every((item) => /^[a-f0-9]{64}$/.test(item.sha256))).toBe(true);
  });
  it("restores into an empty storage what was exported, with the same bytes and types", async () => {
    const directory = await fresh();
    await exportObjects(directory, { prefix });
    await deleteObjects(Object.keys(objects).map(key));
    expect((await importObjects(directory)).objects).toBe(3);
    for (const [name, { body }] of Object.entries(objects))
      expect(await getObject(key(name))).toEqual(body);
  });
  it("refuses a damaged or cut-off file and writes nothing of the copy", async () => {
    const directory = await fresh();
    await exportObjects(directory, { prefix });
    await deleteObjects(Object.keys(objects).map(key));
    // The last of the manifest, so that a copy that wrote as it went would have written
    // the others by the time it found this one.
    await writeFile(path.join(directory, "objects", key("inbound/p/a.eml")), "damaged");
    await expect(importObjects(directory)).rejects.toThrow("object_damaged");
    for (const name of Object.keys(objects)) await expect(getObject(key(name))).rejects.toThrow();
    // The size and the SHA-256 are each checked on their own: a file of the same size
    // with other bytes, and a manifest that names a wrong size for whole bytes.
    await put();
    const same = await fresh();
    await exportObjects(same, { prefix });
    await writeFile(
      path.join(same, "objects", key("attachments/p/b")),
      Buffer.from([9, 9, 9, 9, 9]),
    );
    await expect(importObjects(same)).rejects.toThrow("object_damaged");
    const wrongSize = await fresh();
    await exportObjects(wrongSize, { prefix });
    const lines = (await readFile(path.join(wrongSize, "manifest.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => ({ ...(JSON.parse(line) as object), size: 999 }));
    await writeFile(
      path.join(wrongSize, "manifest.jsonl"),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
    await expect(importObjects(wrongSize)).rejects.toThrow("object_damaged");
    // A copy that did not finish has no manifest.
    await expect(importObjects(await fresh())).rejects.toThrow();
  });
  it.each(["../outside", "a/../b", "/absolute", "x/.."])(
    "does not write or read outside its directory when a manifest names the key %s",
    async (unsafe) => {
      const directory = await fresh();
      await writeFile(
        path.join(directory, "manifest.jsonl"),
        `${JSON.stringify({ key: unsafe, size: 1, sha256: "0".repeat(64), contentType: "x" })}\n`,
      );
      await expect(importObjects(directory)).rejects.toThrow("object_key_unsafe");
    },
  );
});
