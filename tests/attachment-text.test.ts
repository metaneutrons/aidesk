import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  attachments,
  attachmentTexts,
  jobs,
  messages,
  projects,
  tickets,
} from "../src/server/db/schema";
import {
  extractionJob,
  extractionKey,
  extractorVersion,
  recordExtraction,
  textState,
} from "../src/server/attachment-text";
import { initializeStorage, putObject } from "../src/server/storage";
import { maxAttempts, runExtractions } from "../src/worker/extract";
import { docx, pdf } from "./support/documents";
const projectId = randomUUID();
let messageId = "";
// A file that is in the storage and in the table, as an inbound mail leaves it.
async function stored(bytes: Uint8Array | null, name = "file.bin") {
  const objectKey = bytes ? `attachments/${projectId}/${randomUUID()}` : null;
  if (bytes && objectKey)
    await putObject(objectKey, Buffer.from(bytes), "application/octet-stream");
  const [row] = await db()
    .insert(attachments)
    .values({
      messageId,
      projectId,
      position: 0,
      filename: name,
      contentType: "application/octet-stream",
      size: bytes?.length ?? 0,
      checksum: randomUUID(),
      objectKey,
    })
    .returning({ id: attachments.id });
  return row?.id ?? "";
}
const jobsOf = (attachmentId: string) =>
  db()
    .select()
    .from(jobs)
    .where(eq(jobs.dedupKey, extractionKey(attachmentId)));
const run = () => runExtractions({ projectId });
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values({ id: projectId, name: "Texts", slug: `text-${projectId}` });
  const [ticket] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Files",
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
      markdown: "See the file",
    })
    .returning({ id: messages.id });
  messageId = message?.id ?? "";
}, 60_000);
afterAll(async () => {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await sqlClient().end();
});
describe("the text of a file that is not plain text", () => {
  it("is asked for once, read by the worker and then served from the record", async () => {
    const id = await stored(docx(["Quarterly figures", "Second line"]), "figures.docx");
    expect(await textState(projectId, id)).toEqual({ state: "pending" });
    // Asking again queues nothing more.
    expect(await textState(projectId, id)).toEqual({ state: "pending" });
    const queued = await jobsOf(id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type: extractionJob, status: "queued", projectId });
    expect(await run()).toBe(true);
    expect(await textState(projectId, id)).toEqual({
      state: "ready",
      text: "Quarterly figures\nSecond line",
      method: "ooxml-docx",
      unit: "pages",
      units: 1,
      truncated: false,
      hidden: 0,
    });
    expect((await jobsOf(id))[0]).toMatchObject({ status: "succeeded", attempts: 1 });
    // Nothing is due any more, and a later ask does not queue a job again.
    expect(await run()).toBe(false);
    expect((await textState(projectId, id)).state).toBe("ready");
    expect(await jobsOf(id)).toHaveLength(1);
  }, 60_000);
  it("keeps what the reading finds out about a file that cannot be read", async () => {
    const protectedPdf = await stored(
      pdf([[{ text: "x" }]], { password: "hunter2" }),
      "locked.pdf",
    );
    const plainBytes = await stored(Buffer.from("these bytes are no document"), "mystery.bin");
    const refused = await stored(null, "tool.exe");
    for (const id of [protectedPdf, plainBytes, refused]) await textState(projectId, id);
    while (await run());
    expect(await textState(projectId, protectedPdf)).toEqual({
      state: "failed",
      failure: "encrypted",
    });
    expect(await textState(projectId, plainBytes)).toEqual({
      state: "failed",
      failure: "unsupported",
    });
    expect(await textState(projectId, refused)).toEqual({
      state: "failed",
      failure: "unsupported",
    });
  }, 90_000);
  it("is tried again when the storage does not answer, and goes to review after the last attempt", async () => {
    const [row] = await db()
      .insert(attachments)
      .values({
        messageId,
        projectId,
        position: 1,
        filename: "gone.pdf",
        contentType: "application/pdf",
        size: 10,
        checksum: randomUUID(),
        objectKey: `attachments/${projectId}/${randomUUID()}-missing`,
      })
      .returning({ id: attachments.id });
    const id = row?.id ?? "";
    await textState(projectId, id);
    expect(await run()).toBe(true);
    const [first] = await jobsOf(id);
    expect(first).toMatchObject({
      status: "queued",
      attempts: 1,
      lastErrorCode: "extraction_unavailable",
    });
    expect(first?.runAfter.getTime()).toBeGreaterThan(Date.now());
    // While it waits, the answer is pending, and nothing is due.
    expect(await textState(projectId, id)).toEqual({ state: "pending" });
    expect(await run()).toBe(false);
    // The last attempt ends in review, which the answer says.
    await db()
      .update(jobs)
      .set({ attempts: maxAttempts - 1, runAfter: new Date() })
      .where(eq(jobs.dedupKey, extractionKey(id)));
    expect(await run()).toBe(true);
    expect((await jobsOf(id))[0]).toMatchObject({
      status: "review",
      lastErrorCode: "extraction_unavailable",
    });
    expect(await textState(projectId, id)).toEqual({ state: "failed", failure: "failed" });
  }, 60_000);
  it("puts a job for a file that is gone into review, and takes back a job whose worker disappeared", async () => {
    const ghost = randomUUID();
    await db()
      .insert(jobs)
      .values({
        projectId,
        type: extractionJob,
        dedupKey: extractionKey(ghost),
        payload: { attachmentId: ghost },
      });
    expect(await run()).toBe(true);
    expect((await jobsOf(ghost))[0]).toMatchObject({
      status: "review",
      lastErrorCode: "attachment_missing",
    });
    const id = await stored(docx(["Recovered after a lost worker"]), "lost.docx");
    await db()
      .insert(jobs)
      .values({
        projectId,
        type: extractionJob,
        dedupKey: extractionKey(id),
        payload: { attachmentId: id },
        status: "running",
        leaseUntil: new Date(Date.now() - 60_000),
      });
    expect(await run()).toBe(true);
    expect(await textState(projectId, id)).toMatchObject({
      state: "ready",
      text: "Recovered after a lost worker",
    });
    // A payload that is not a file id is a job for review as well.
    await db()
      .insert(jobs)
      .values({
        projectId,
        type: extractionJob,
        dedupKey: `broken:${randomUUID()}`,
        payload: { attachmentId: "not-an-id" },
      });
    expect(await run()).toBe(true);
  }, 60_000);
  it("ignores a result of another version of the reader and asks again", async () => {
    const id = await stored(docx(["New reader"]), "versions.docx");
    await db()
      .insert(attachmentTexts)
      .values({
        attachmentId: id,
        projectId,
        version: extractorVersion - 1,
        text: "old reader",
        method: "old",
      });
    expect(await textState(projectId, id)).toEqual({ state: "pending" });
    expect(await run()).toBe(true);
    expect(await textState(projectId, id)).toMatchObject({ state: "ready", text: "New reader" });
    const rows = await db()
      .select()
      .from(attachmentTexts)
      .where(eq(attachmentTexts.attachmentId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(extractorVersion);
  }, 60_000);
  it("keeps one record per file and follows the file when it is deleted", async () => {
    const id = await stored(null, "records.bin");
    await recordExtraction(projectId, id, { ok: false, reason: "damaged" });
    await recordExtraction(projectId, id, {
      ok: true,
      method: "test",
      text: "second",
      units: 2,
      unit: "slides",
      truncated: true,
      hidden: 3,
    });
    const rows = await db()
      .select()
      .from(attachmentTexts)
      .where(eq(attachmentTexts.attachmentId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: "second", failure: null, units: 2, hidden: 3 });
    await db()
      .delete(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.projectId, projectId)));
    expect(
      await db().select().from(attachmentTexts).where(eq(attachmentTexts.attachmentId, id)),
    ).toHaveLength(0);
  });
});
