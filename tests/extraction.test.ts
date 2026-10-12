import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import MailComposer from "nodemailer/lib/mail-composer";
import { db, sqlClient } from "../src/server/db";
import { attachments, ingress, jobs, messages, projects, tickets } from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import { getOriginal, getTicket } from "../src/server/operations";
import { initializeStorage } from "../src/server/storage";
import { extractReply } from "../src/domain/extraction";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const reader: Principal = {
  id: `reader-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
};
async function ingest(fields: { html?: string; text?: string; attachments?: object[] }) {
  const raw = await new MailComposer({
    from: "Alex <alex@example.test>",
    to: "support@example.test",
    subject: `Extraction ${randomUUID()}`,
    messageId: `<${randomUUID()}@example.test>`,
    ...fields,
  })
    .compile()
    .build();
  const { ingressId } = await acceptInbound({
    projectId,
    connectionId: null,
    externalKey: `test:${randomUUID()}`,
    raw,
  });
  expect(await processIngress(ingressId)).toBe("created");
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  const conversation = await getTicket(reader, entry?.ticketId ?? "");
  const [message] = conversation.messages;
  return { raw, message };
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Extraction", slug: `extraction-${projectId}` },
      { id: otherProject, name: "Other", slug: `extraction-${otherProject}` },
    ]);
});
afterAll(async () => {
  const ids = [projectId, otherProject];
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(ingress).where(inArray(ingress.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("extraction fixtures", () => {
  it("removes a signature also when HTML conversion escaped its delimiter", () => {
    expect(extractReply("Thanks  \n\\--  \nAlex  \nACME")).toEqual({
      markdown: "Thanks",
      trimmed: true,
      uncertain: false,
    });
  });
  it("removes nested quotations of the earlier thread", () => {
    expect(
      extractReply("New question.\n\nOn Mon, Orbit wrote:\n> older\n> \n> > oldest\n> > more"),
    ).toEqual({ markdown: "New question.", trimmed: true, uncertain: false });
  });
  it("keeps inline replies between quotes and code after a quote", () => {
    const inline = "> Which version?\n2.4\n\n> Which system?\nmacOS 26\n\n```\nnpm run build\n```";
    expect(extractReply(inline)).toEqual({ markdown: inline, trimmed: false, uncertain: false });
  });
  it("marks heuristic trims of unquoted text as uncertain", () => {
    const outlook =
      "Please see below.\n\nFrom: Orbit Support\nSent: Monday\nTo: Alex\nSubject: Export\n\nEarlier text";
    expect(extractReply(outlook)).toEqual({
      markdown: "Please see below.",
      trimmed: true,
      uncertain: true,
    });
    expect(extractReply("Done.\n\n-----Original Message-----\nEarlier text")).toMatchObject({
      markdown: "Done.",
      uncertain: true,
    });
    const long = [
      "Short answer.",
      "-- ",
      ...Array.from({ length: 9 }, (_, i) => `line ${String(i)}`),
    ];
    expect(extractReply(long.join("\n"))).toMatchObject({
      markdown: "Short answer.",
      uncertain: true,
    });
  });
});
describe("extraction through inbound processing", () => {
  it("keeps the new statement, code and files of an HTML reply", async () => {
    const { message } = await ingest({
      html: [
        "<p>The build fails with this command:</p>",
        "<pre><code>npm run build --prod</code></pre>",
        '<p><img src="cid:shot@example.test" alt="screenshot"></p>',
        '<div class="gmail_signature">Alex<br>ACME Ltd.<br>+49 30 123</div>',
        "<div>On Mon, Orbit wrote:</div>",
        "<blockquote><p>Can you send the command?</p><blockquote><p>It fails.</p></blockquote></blockquote>",
      ].join(""),
      attachments: [
        { filename: "shot.png", content: Buffer.from("png"), cid: "shot@example.test" },
        { filename: "build.log", content: "error at line 3" },
      ],
    });
    expect(message?.markdown).toContain("The build fails with this command:");
    expect(message?.markdown).toContain("```\nnpm run build --prod\n```");
    for (const removed of ["ACME", "Can you send", "It fails"])
      expect(message?.markdown).not.toContain(removed);
    expect(message?.source).toMatchObject({ trimmed: true, uncertain: false });
    expect(message?.extractionUncertain).toBe(false);
    expect(message?.attachments.map((file) => [file.filename, file.inline])).toEqual([
      ["shot.png", true],
      ["build.log", false],
    ]);
    expect(
      await db()
        .select()
        .from(attachments)
        .where(eq(attachments.messageId, message?.id ?? "")),
    ).toHaveLength(2);
  });
  it("flags an uncertain trim and serves the private original to readers only", async () => {
    const { raw, message } = await ingest({
      html: "<p>Please see below.</p><p>From: Orbit Support<br>Sent: Monday<br>To: Alex<br>Subject: Export</p><p>Earlier text</p>",
    });
    expect(message?.extractionUncertain).toBe(true);
    expect(message?.hasOriginal).toBe(true);
    expect(JSON.stringify(message)).not.toContain("inbound/");
    const original = await getOriginal(reader, message?.id ?? "");
    expect(Buffer.compare(original.content, raw)).toBe(0);
    expect(original.filename).toMatch(/^ticket-\d+-[0-9a-f]{8}\.eml$/);
    const outsider: Principal = {
      ...reader,
      grants: [{ projectId: otherProject, actions: ["ticket.read"] }],
    };
    await expect(getOriginal(outsider, message?.id ?? "")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getOriginal({ ...reader, grants: [] }, message?.id ?? "")).rejects.toMatchObject({
      code: "not_found",
    });
    // Messages written in aidesk have no received original.
    const [note] = await db()
      .insert(messages)
      .values({
        ticketId:
          (
            await db()
              .select()
              .from(messages)
              .where(eq(messages.id, message?.id ?? ""))
          )[0]?.ticketId ?? "",
        authorType: "human",
        authorName: "Agent",
        markdown: "Note",
        language: "en",
        internal: true,
        deliveryState: "internal",
      })
      .returning({ id: messages.id });
    await expect(getOriginal(reader, note?.id ?? "")).rejects.toMatchObject({ code: "not_found" });
  });
});
