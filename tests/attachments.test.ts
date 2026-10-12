import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import MailComposer from "nodemailer/lib/mail-composer";
import { db, sqlClient } from "../src/server/db";
import {
  agents,
  attachments,
  ingress,
  jobs,
  messages,
  projects,
  tickets,
} from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import { getAttachment, getTicket } from "../src/server/operations";
import { getObject, initializeStorage } from "../src/server/storage";
import { tokenHash } from "../src/server/principal";
import { GET } from "../src/app/api/v1/[[...path]]/route";
import { attachmentLimits, attachmentRefusal, safeFilename } from "../src/domain/attachments";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const bearer = `aidesk_${randomBytes(32).toString("base64url")}`;
const reader: Principal = {
  id: "attachment-reader",
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
};
const stranger: Principal = {
  ...reader,
  grants: [{ projectId: otherProject, actions: ["project.read", "ticket.read"] }],
};
interface Attachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  cid?: string;
}
async function compose(fields: { html?: string; text?: string; attachments?: Attachment[] }) {
  return new MailComposer({
    from: "Alex <alex@example.test>",
    to: "support@example.test",
    subject: "Files",
    messageId: `<${randomUUID()}@example.test>`,
    ...fields,
  })
    .compile()
    .build();
}
async function ingest(raw: Buffer) {
  const { ingressId } = await acceptInbound({
    projectId,
    connectionId: null,
    externalKey: `test:${randomUUID()}`,
    raw,
  });
  expect(await processIngress(ingressId)).toBe("created");
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  return getTicket(reader, entry?.ticketId ?? "");
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Attachments", slug: `att-${projectId}` },
      { id: otherProject, name: "Other", slug: `att-${otherProject}` },
    ]);
  await db()
    .insert(agents)
    .values({
      name: "Reader",
      projectId,
      actions: ["project.read", "ticket.read"],
      tokenHash: tokenHash(bearer),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
});
afterAll(async () => {
  const ids = [projectId, otherProject];
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(ingress).where(inArray(ingress.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("attachment rules", () => {
  it("cleans names without losing the extension", () => {
    expect(safeFilename("../../etc/passwd", 0)).toBe("etcpasswd");
    expect(safeFilename("re\u0000port\u001f.pdf", 0)).toBe("report.pdf");
    expect(safeFilename(" .hidden ", 0)).toBe("hidden");
    expect(safeFilename(undefined, 2)).toBe("attachment-3");
    expect(safeFilename("...", 0)).toBe("attachment-1");
    const long = safeFilename(`${"a".repeat(300)}.docx`, 0);
    expect(long).toHaveLength(180);
    expect(long.endsWith(".docx")).toBe(true);
    // Without a short extension the name is simply cut.
    expect(safeFilename("b".repeat(300), 0)).toBe("b".repeat(180));
    expect(safeFilename(`${"c".repeat(200)}.${"d".repeat(40)}`, 0)).toHaveLength(180);
  });
  it("refuses executable types, oversized files and too many files", () => {
    const file = { filename: "report.pdf", contentType: "application/pdf", size: 10 };
    expect(attachmentRefusal(file, 0)).toBeNull();
    expect(attachmentRefusal({ ...file, filename: "README" }, 0)).toBeNull();
    expect(
      attachmentRefusal({ ...file, filename: "exe", contentType: "text/plain" }, 0),
    ).toBeNull();
    expect(attachmentRefusal({ ...file, filename: "invoice.pdf.exe" }, 0)).toBe(
      "attachment_type_blocked",
    );
    expect(attachmentRefusal({ ...file, filename: "SETUP.MSI" }, 0)).toBe(
      "attachment_type_blocked",
    );
    expect(attachmentRefusal({ ...file, contentType: "application/x-msdownload" }, 0)).toBe(
      "attachment_type_blocked",
    );
    expect(attachmentRefusal({ ...file, size: attachmentLimits.maxBytes }, 0)).toBeNull();
    expect(attachmentRefusal({ ...file, size: attachmentLimits.maxBytes + 1 }, 0)).toBe(
      "attachment_too_large",
    );
    expect(attachmentRefusal(file, attachmentLimits.maxCount - 1)).toBeNull();
    expect(attachmentRefusal(file, attachmentLimits.maxCount)).toBe("attachment_count_exceeded");
  });
});
describe("inbound attachments", () => {
  it("stores allowed files privately and records refused ones with the reason", async () => {
    const pdf = randomBytes(2048);
    const png = randomBytes(512);
    const conversation = await ingest(
      await compose({
        html: '<p>See the files.</p><img src="cid:logo@example.test">',
        attachments: [
          { filename: "report.pdf", content: pdf, contentType: "application/pdf" },
          {
            filename: "tool.exe",
            content: randomBytes(64),
            contentType: "application/octet-stream",
          },
          {
            filename: "logo.png",
            content: png,
            contentType: "image/png",
            cid: "logo@example.test",
          },
        ],
      }),
    );
    const [message] = conversation.messages;
    expect(
      message?.attachments.map(({ filename, refusal, inline }) => ({ filename, refusal, inline })),
    ).toEqual([
      // Order as received: the related inline image precedes the attachments.
      { filename: "logo.png", refusal: null, inline: true },
      { filename: "report.pdf", refusal: null, inline: false },
      { filename: "tool.exe", refusal: "attachment_type_blocked", inline: false },
    ]);
    const rows = await db()
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, message?.id ?? ""));
    const stored = rows.find((row) => row.filename === "report.pdf");
    expect(stored?.objectKey).toBe(`attachments/${projectId}/${stored?.checksum ?? ""}`);
    expect(Buffer.compare(await getObject(stored?.objectKey ?? ""), pdf)).toBe(0);
    expect(rows.find((row) => row.filename === "tool.exe")?.objectKey).toBeNull();
    expect(rows.find((row) => row.filename === "logo.png")?.contentId).toBe("logo@example.test");
    // The metadata does not reveal storage keys or checksums.
    expect(JSON.stringify(conversation)).not.toContain("attachments/");
    // Download through the shared operation and the REST surface.
    const file = await getAttachment(reader, stored?.id ?? "");
    expect(Buffer.compare(file.content, pdf)).toBe(0);
    const response = await GET(
      new Request(`http://localhost:3000/api/v1/attachments/${stored?.id ?? ""}`, {
        headers: { authorization: `Bearer ${bearer}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, no-store",
    });
    expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), pdf)).toBe(0);
    // Refused files, other projects and missing grants all answer not_found.
    const refused = rows.find((row) => row.filename === "tool.exe")?.id ?? "";
    await expect(getAttachment(reader, refused)).rejects.toMatchObject({ code: "not_found" });
    await expect(getAttachment(stranger, stored?.id ?? "")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getAttachment({ ...reader, grants: [] }, stored?.id ?? "")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getAttachment(reader, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    expect(
      (
        await GET(
          new Request(`http://localhost:3000/api/v1/attachments/${refused}`, {
            headers: { authorization: `Bearer ${bearer}` },
          }),
        )
      ).status,
    ).toBe(404);
  });
  it("encodes names that are not plain ASCII", async () => {
    const conversation = await ingest(
      await compose({
        text: "Umlauts",
        attachments: [{ filename: 'Bericht "März".pdf', content: randomBytes(16) }],
      }),
    );
    const id = conversation.messages[0]?.attachments[0]?.id ?? "";
    const response = await GET(
      new Request(`http://localhost:3000/api/v1/attachments/${id}`, {
        headers: { authorization: `Bearer ${bearer}` },
      }),
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="Bericht _M_rz_.pdf"; filename*=UTF-8''Bericht%20%22M%C3%A4rz%22.pdf`,
    );
  });
  it("refuses an oversized file and files beyond the limit but keeps the message", async () => {
    const conversation = await ingest(
      await compose({
        text: "Many files",
        attachments: [
          { filename: "big.bin", content: Buffer.alloc(attachmentLimits.maxBytes + 1) },
          ...Array.from({ length: attachmentLimits.maxCount }, (_, index) => ({
            filename: `note-${String(index)}.txt`,
            content: Buffer.from(`note ${String(index)}`),
          })),
        ],
      }),
    );
    const [message] = conversation.messages;
    expect(message?.markdown).toBe("Many files");
    const files = message?.attachments ?? [];
    expect(files).toHaveLength(attachmentLimits.maxCount + 1);
    expect(files[0]?.refusal).toBe("attachment_too_large");
    expect(files.slice(1, attachmentLimits.maxCount).every((file) => file.refusal === null)).toBe(
      true,
    );
    expect(files.at(-1)?.refusal).toBe("attachment_count_exceeded");
    const rows = await db()
      .select({ objectKey: attachments.objectKey, refusal: attachments.refusal })
      .from(attachments)
      .where(eq(attachments.messageId, message?.id ?? ""));
    expect(rows.filter((row) => row.refusal).every((row) => row.objectKey === null)).toBe(true);
  });
  it("never turns active markup from a mail into executable HTML", async () => {
    const conversation = await ingest(
      await compose({
        html: [
          "<p>Hello</p>",
          "<script>alert(1)</script>",
          '<img src="x" onerror="alert(2)">',
          '<a href="javascript:alert(3)">click</a>',
          '<iframe src="https://example.test"></iframe>',
          "<style>body{display:none}</style>",
        ].join(""),
      }),
    );
    const html = conversation.messages[0]?.html ?? "";
    expect(html).toContain("Hello");
    for (const unsafe of ["<script", "onerror", "javascript:", "<iframe", "<style"])
      expect(html.toLowerCase()).not.toContain(unsafe);
    const [stored] = await db()
      .select({ markdown: messages.markdown })
      .from(messages)
      .where(eq(messages.id, conversation.messages[0]?.id ?? ""));
    expect(stored?.markdown).not.toContain("<script");
  });
});
