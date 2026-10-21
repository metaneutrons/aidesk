import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { strFromU8, unzipSync } from "fflate";
import MailComposer from "nodemailer/lib/mail-composer";
import { db, sqlClient } from "../src/server/db";
import {
  attachments,
  attachmentTexts,
  audit,
  ingress,
  jobs,
  memberships,
  messages,
  participants,
  projectExports,
  projects,
  tickets,
  user,
} from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import { exportRequester } from "../src/server/requester-export";
import { initializeStorage } from "../src/server/storage";
import { requesterExportInput } from "../src/domain/requester-export";
import { actions, type Action, type Principal } from "../src/domain/permissions";
import { operatorRoles } from "../src/domain/roles";
const run = randomUUID().slice(0, 8);
const projectId = randomUUID();
const otherProject = randomUUID();
const person = (held: Action[], project = projectId, id = `export-${run}`): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId: project, actions: held }],
});
const manager = person(["project.read", "data.export", "ticket.read"]);
const reader = person(["project.read", "ticket.read"], projectId, `export-reader-${run}`);
const outsider = person(["data.export"], otherProject, `export-outsider-${run}`);
async function arrive(
  from: string,
  subject: string,
  files: { filename: string; content: Buffer }[] = [],
  headers: Record<string, string> = {},
) {
  const raw = await new MailComposer({
    from: `Person <${from}>`,
    to: "support@example.test",
    subject,
    text: `Text of ${subject}`,
    messageId: `<${randomUUID()}@example.test>`,
    headers,
    attachments: files,
  })
    .compile()
    .build();
  const { ingressId } = await acceptInbound({
    projectId,
    connectionId: null,
    externalKey: `test:${randomUUID()}`,
    raw,
  });
  await processIngress(ingressId);
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  return { ingressId, ticketId: entry?.ticketId ?? "" };
}
const unzip = (content: Buffer) => unzipSync(new Uint8Array(content));
const rows = (files: Record<string, Uint8Array>, name: string) =>
  strFromU8(files[name] ?? new Uint8Array())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const clear = async () => {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(ingress).where(eq(ingress.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
};
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Export", slug: `rexport-${run}` },
      { id: otherProject, name: "Other", slug: `rexport-other-${run}` },
    ]);
  const people = [manager, reader, outsider];
  await db()
    .insert(user)
    .values(
      people.map((who) => ({
        id: who.id,
        name: who.id,
        email: `${who.id}@example.test`,
        emailVerified: true,
      })),
    );
  await db()
    .insert(memberships)
    .values(
      people.map((who) => ({
        userId: who.id,
        projectId: who.grants[0]?.projectId ?? projectId,
        actions: [...(who.grants[0]?.actions ?? [])],
      })),
    );
}, 60_000);
afterAll(async () => {
  await clear();
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProject]));
  await db()
    .delete(user)
    .where(inArray(user.id, [manager.id, reader.id, outsider.id]));
  await sqlClient().end();
});
describe("the export about a requester", () => {
  it("holds the tickets, messages, notes, files, originals and mail of the address, and nothing of others", async () => {
    await clear();
    const mine = await arrive("Kim@Example.test", "Mine", [
      { filename: "own.txt", content: Buffer.from(`own ${run}`) },
    ]);
    await arrive("kim@example.test", "Second");
    const other = await arrive("lee@example.test", "Other", [
      { filename: "lee.txt", content: Buffer.from(`lee ${run}`) },
    ]);
    const junk = await arrive("kim@example.test", "Offer", [], { "X-Spam-Flag": "YES" });
    // An internal note on the ticket, a portal record on the ticket of another person, an audit entry about the ticket.
    await db().insert(messages).values({
      ticketId: mine.ticketId,
      authorType: "human",
      authorName: "Alex",
      internal: true,
      markdown: "Private note about Kim",
    });
    // A worker of another test file may have answered these tickets by now, which gives the requester a portal record.
    // The count below is about the one record that this test adds.
    await db().delete(jobs).where(eq(jobs.projectId, projectId));
    await db()
      .delete(participants)
      .where(inArray(participants.ticketId, [mine.ticketId, other.ticketId]));
    await db().insert(participants).values({ ticketId: other.ticketId, email: "kim@example.test" });
    await db()
      .insert(audit)
      .values([
        {
          projectId,
          actorId: "x",
          action: "ticket.tags",
          targetId: mine.ticketId,
          detail: { tags: ["vip"] },
        },
        {
          projectId,
          actorId: "x",
          action: "ticket.tags",
          targetId: other.ticketId,
          detail: { tags: ["lee"] },
        },
      ]);
    // A ticket that holds the address in another case, and the extracted text of an attachment.
    await db().insert(tickets).values({
      projectId,
      subject: "Mixed case",
      requesterEmail: "Kim@EXAMPLE.test",
      requesterName: "Kim",
      language: "en",
    });
    // The file belongs to the message that came with the mail, not to the note added above (the order of rows is not fixed).
    const [attached] = await db()
      .select({ id: attachments.id })
      .from(attachments)
      .innerJoin(messages, eq(attachments.messageId, messages.id))
      .where(eq(messages.ticketId, mine.ticketId));
    expect(attached?.id).toBeTruthy();
    await db()
      .insert(attachmentTexts)
      .values({
        attachmentId: attached?.id ?? "",
        projectId,
        version: 1,
        text: `Extracted ${run}`,
      });
    const file = await exportRequester(manager, projectId, { email: "  KIM@example.test " });
    const files = unzip(file.content);
    const ticketLines = rows(files, "tickets.ndjson");
    expect(ticketLines.map((ticket) => ticket.subject).sort()).toEqual([
      "Mine",
      "Mixed case",
      "Second",
    ]);
    expect(JSON.stringify(rows(files, "attachment-texts.ndjson"))).toContain(`Extracted ${run}`);
    const messageRows = rows(files, "messages.ndjson");
    expect(messageRows.map((message) => message.markdown).join("\n")).toContain(
      "Private note about Kim",
    );
    expect(messageRows.some((message) => message.internal === true)).toBe(true);
    expect(rows(files, "participants.ndjson").map((entry) => entry.email)).toContain(
      "kim@example.test",
    );
    expect(rows(files, "ingress.ndjson").map((entry) => entry.id)).toContain(junk.ingressId);
    expect(rows(files, "audit.ndjson").map((entry) => entry.action)).toEqual(["ticket.tags"]);
    expect(JSON.stringify(rows(files, "audit.ndjson"))).toContain("vip");
    expect(JSON.stringify(rows(files, "audit.ndjson"))).not.toContain("lee");
    // The files and the originals that the rows name are in the archive; those of the other person are not.
    const objects = Object.keys(files).filter((name) => name.startsWith("objects/"));
    expect(objects.some((name) => name.includes("attachments/"))).toBe(true);
    expect(objects.some((name) => name.includes("inbound/"))).toBe(true);
    const everything = Buffer.concat(
      Object.values(files).map((data) => Buffer.from(data)),
    ).toString("latin1");
    expect(everything).toContain(`own ${run}`);
    expect(everything).not.toContain(`lee ${run}`);
    expect(everything).not.toContain("Text of Other");
    // The manifest names each file with its size and checksum, and the counts.
    const manifest = JSON.parse(strFromU8(files["manifest.json"] ?? new Uint8Array())) as {
      format: string;
      requester: string;
      counts: Record<string, number>;
      files: { path: string }[];
    };
    expect(manifest).toMatchObject({
      format: "aidesk-requester-export-1",
      requester: "kim@example.test",
    });
    expect(manifest.counts).toMatchObject({ tickets: 3, portalRecords: 1, audit: 1 });
    expect(manifest.files.map((entry) => entry.path)).toContain("tickets.ndjson");
    expect(file.filename).toMatch(/^requester-[a-f0-9]{12}-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(file.filename).not.toContain("kim");
    expect(file.digest).toMatch(/^[a-f0-9]{64}$/);
  });
  it("is an entry of the audit with the digest of the address, and is kept nowhere", async () => {
    await clear();
    await arrive("kim@example.test", "Mine");
    const before = (
      await db().select().from(projectExports).where(eq(projectExports.projectId, projectId))
    ).length;
    const file = await exportRequester(manager, projectId, { email: "kim@example.test" });
    const entries = (await db().select().from(audit).where(eq(audit.projectId, projectId))).filter(
      (entry) => entry.action === "requester.export",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorId: manager.id,
      detail: {
        digest: file.digest,
        requester: expect.stringMatching(/^[a-f0-9]{64}$/),
        counts: { tickets: 1 },
      },
    });
    expect(JSON.stringify(entries[0])).not.toContain("kim@example.test");
    expect(
      (await db().select().from(projectExports).where(eq(projectExports.projectId, projectId)))
        .length,
    ).toBe(before);
  });
  it("is an empty archive for an address without data, and refuses what is not allowed", async () => {
    await clear();
    await arrive("lee@example.test", "Lee");
    const file = await exportRequester(manager, projectId, { email: "nobody@example.test" });
    const files = unzip(file.content);
    expect(rows(files, "tickets.ndjson")).toEqual([]);
    expect(Object.keys(files).some((name) => name.startsWith("objects/"))).toBe(false);
    // Managing the project is not enough, no preset holds the action, and the owner holds no right to project data.
    const managerOnly = person(
      ["project.read", "project.manage", "ticket.read"],
      projectId,
      `export-m-${run}`,
    );
    const owner: Principal = { ...manager, id: `export-owner-${run}`, owner: true, grants: [] };
    for (const call of [
      () => exportRequester(reader, projectId, { email: "lee@example.test" }),
      () => exportRequester(outsider, projectId, { email: "lee@example.test" }),
      () => exportRequester(managerOnly, projectId, { email: "lee@example.test" }),
      () => exportRequester(owner, projectId, { email: "lee@example.test" }),
    ])
      await expect(call()).rejects.toMatchObject({ code: "not_found" });
    expect(actions).toContain("data.export");
    for (const preset of Object.values(operatorRoles)) expect(preset).not.toContain("data.export");
    for (const call of [
      () =>
        exportRequester({ ...manager, kind: "agent" }, projectId, { email: "lee@example.test" }),
      () =>
        exportRequester({ ...manager, active: false }, projectId, { email: "lee@example.test" }),
    ])
      await expect(call()).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      exportRequester(manager, projectId, { email: "not an address" }),
    ).rejects.toThrow();
    await expect(
      exportRequester(manager, randomUUID(), { email: "lee@example.test" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(requesterExportInput.safeParse({ email: "a@b.test", extra: 1 }).success).toBe(false);
  });
  it("stops at the ceiling of an export", async () => {
    await clear();
    await arrive("kim@example.test", "Big", [
      { filename: "big.txt", content: Buffer.alloc(4096, 1) },
    ]);
    await expect(
      exportRequester(manager, projectId, { email: "kim@example.test" }, 2048),
    ).rejects.toMatchObject({ code: "project_export_too_large", status: 413 });
    expect(
      (await db().select().from(audit).where(eq(audit.projectId, projectId))).some(
        (entry) => entry.action === "requester.export",
      ),
    ).toBe(false);
  });
});
