import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  attachments,
  ingress,
  messages,
  projectExports,
  projects,
  tickets,
} from "../src/server/db/schema";
import { sweepObjects } from "../src/server/object-sweep";
import {
  deleteObjects,
  getObject,
  initializeStorage,
  listObjects,
  putObject,
} from "../src/server/storage";
// The objects of the storage that no row names, and only those, are found and removed.
const projectId = randomUUID();
const prefix = `sweep-${randomUUID()}/`;
const key = (name: string) => `${prefix}${name}`;
const later = new Date(Date.now() + 48 * 3600 * 1000);
let messageId = "";
const exists = async (name: string) => {
  try {
    await getObject(key(name));
    return true;
  } catch {
    return false;
  }
};
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values({ id: projectId, name: "Sweep", slug: `sweep-${projectId}` });
  const [ticket] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Sweep",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
    })
    .returning({ id: tickets.id });
  const [message] = await db()
    .insert(messages)
    .values({
      ticketId: ticket?.id ?? "",
      authorType: "customer",
      authorName: "Kim",
      markdown: "Hello",
      rawObjectKey: key("original.eml"),
    })
    .returning({ id: messages.id });
  messageId = message?.id ?? "";
  await db()
    .insert(attachments)
    .values({
      messageId,
      projectId,
      position: 0,
      filename: "a.txt",
      contentType: "text/plain",
      size: 1,
      checksum: randomUUID(),
      objectKey: key("file"),
    });
  await db()
    .insert(ingress)
    .values({
      projectId,
      externalKey: `sweep:${projectId}`,
      rawObjectKey: key("ingress.eml"),
      checksum: "x",
    });
  for (const name of ["original.eml", "file", "ingress.eml", "orphan-a", "orphan-b"])
    await putObject(key(name), Buffer.from(name), "text/plain");
}, 60_000);
afterAll(async () => {
  await deleteObjects([
    key("original.eml"),
    key("file"),
    key("ingress.eml"),
    key("orphan-a"),
    key("orphan-b"),
  ]);
  await db().delete(ingress).where(eq(ingress.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await sqlClient().end();
});
describe("the sweep of the storage", () => {
  it("lists the objects of a prefix and deletes a list of keys", async () => {
    const extra = key("extra");
    await putObject(extra, Buffer.from("x"), "text/plain");
    const names: string[] = [];
    for await (const object of listObjects(prefix)) names.push(object.key);
    expect(names).toContain(extra);
    expect(names.every((name) => name.startsWith(prefix))).toBe(true);
    expect(await deleteObjects([extra])).toEqual([]);
    expect(await exists("extra")).toBe(false);
  });
  it("names what no row names, and nothing that a message, an attachment or an ingress names", async () => {
    const found = await sweepObjects({ prefix, now: later });
    expect(found.unreferenced.map((object) => object.key).sort()).toEqual([
      key("orphan-a"),
      key("orphan-b"),
    ]);
    expect(found).toMatchObject({ scanned: 5, referenced: 3, tooYoung: 0, deleted: 0 });
    // A dry run removes nothing.
    expect(await exists("orphan-a")).toBe(true);
  });
  it("reads every page of a listing, not only the first", async () => {
    const found = await sweepObjects({ prefix, now: later, pageSize: 2 });
    expect(found).toMatchObject({ scanned: 5, referenced: 3 });
    expect(found.unreferenced).toHaveLength(2);
  });
  it("keeps an object that is younger than the grace period, because its row may not exist yet", async () => {
    const found = await sweepObjects({ prefix, remove: true });
    expect(found).toMatchObject({ referenced: 3, tooYoung: 2, deleted: 0 });
    expect(found.unreferenced).toEqual([]);
    expect(await exists("orphan-a")).toBe(true);
  });
  it("removes the objects that no row names once they are old enough, and no other", async () => {
    const removed = await sweepObjects({ prefix, remove: true, now: later });
    expect(removed).toMatchObject({ deleted: 2, failed: [] });
    expect(await exists("orphan-a")).toBe(false);
    expect(await exists("orphan-b")).toBe(false);
    for (const name of ["original.eml", "file", "ingress.eml"])
      expect(await exists(name)).toBe(true);
    // A second sweep finds nothing.
    expect((await sweepObjects({ prefix, now: later })).unreferenced).toEqual([]);
  });
  it("finds the object of a ticket that was deleted, after the rows went with it", async () => {
    await db().delete(attachments).where(eq(attachments.messageId, messageId));
    const found = await sweepObjects({ prefix, now: later });
    expect(found.unreferenced.map((object) => object.key)).toEqual([key("file")]);
  });
});
describe("the file of an export of a project", () => {
  it("is kept as long as the row of the export names it, and is unreferenced when the row is gone", async () => {
    await putObject(key("export.zip"), Buffer.from("zip"), "application/zip");
    const [made] = await db()
      .insert(projectExports)
      .values({
        projectId,
        projectName: "Sweep",
        digest: "d",
        bytes: 3,
        counts: {},
        objectKey: key("export.zip"),
        createdBy: "someone",
      })
      .returning({ id: projectExports.id });
    try {
      const kept = await sweepObjects({ prefix, now: later });
      expect(kept.unreferenced.map((object) => object.key)).not.toContain(key("export.zip"));
      expect(await sweepObjects({ prefix, remove: true, now: later })).toMatchObject({
        failed: [],
      });
      expect(await exists("export.zip")).toBe(true);
    } finally {
      await db()
        .delete(projectExports)
        .where(eq(projectExports.id, made?.id ?? ""));
    }
    const gone = await sweepObjects({ prefix, now: later });
    expect(gone.unreferenced.map((object) => object.key)).toContain(key("export.zip"));
    await deleteObjects([key("export.zip")]);
  });
});
