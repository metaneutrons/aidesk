import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, ingress, jobs, messages, projects, tickets } from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import {
  getJunkMail,
  getTicket,
  listJunk,
  listTickets,
  moveTicketToJunk,
  reply,
  restoreJunkMail,
  restoreTicket,
} from "../src/server/operations";
import { initializeStorage } from "../src/server/storage";
import { classifyJunk } from "../src/domain/junk";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const triager: Principal = {
  id: `triager-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [
    {
      projectId,
      actions: ["project.read", "ticket.read", "ticket.reply", "ticket.note", "ticket.junk"],
    },
  ],
};
const reader: Principal = {
  ...triager,
  id: `reader-${projectId}`,
  grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
};
const outsider: Principal = {
  ...triager,
  id: `outsider-${projectId}`,
  grants: [{ projectId: otherProject, actions: ["ticket.read", "ticket.junk"] }],
};
function mail(fields: { from?: string; headers?: string[]; inReplyTo?: string; html?: string }) {
  return Buffer.from(
    [
      `From: ${fields.from ?? "Kim <kim@example.test>"}`,
      "To: support@example.test",
      `Subject: Offer ${randomUUID()}`,
      `Message-ID: <${randomUUID()}@example.test>`,
      ...(fields.inReplyTo ? [`In-Reply-To: ${fields.inReplyTo}`] : []),
      ...(fields.headers ?? []),
      "MIME-Version: 1.0",
      fields.html ? "Content-Type: text/html; charset=utf-8" : "Content-Type: text/plain",
      "",
      fields.html ?? "Hello",
      "",
    ].join("\r\n"),
  );
}
async function ingest(raw: Buffer) {
  const { ingressId } = await acceptInbound({
    projectId,
    connectionId: null,
    externalKey: `test:${randomUUID()}`,
    raw,
  });
  const outcome = await processIngress(ingressId);
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  return { ingressId, outcome, entry };
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Junk", slug: `junk-${projectId}` },
      { id: otherProject, name: "Other", slug: `junk-${otherProject}` },
    ]);
});
afterAll(async () => {
  const ids = [projectId, otherProject];
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(ingress).where(inArray(ingress.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("junk classification", () => {
  it("follows the verdict of an upstream spam filter", () => {
    const verdict = (entries: [string, unknown][]) => classifyJunk(new Map(entries));
    expect(verdict([["x-spam-flag", "YES"]])).toEqual({ junk: true, reason: "spam_flag" });
    expect(verdict([["x-spam-status", "Yes, score=9.1 required=5.0"]])).toEqual({
      junk: true,
      reason: "spam_status",
    });
    expect(verdict([["x-spam", { value: "Yes" }]]).junk).toBe(true);
    expect(verdict([["x-spam-flag", "NO"]]).junk).toBe(false);
    expect(verdict([["x-spam-status", "No, score=0.1"]]).junk).toBe(false);
    expect(verdict([["x-spam", 1]]).junk).toBe(false);
    expect(verdict([]).junk).toBe(false);
  });
});
describe("junk mail", () => {
  it("keeps classified mail out of tickets and restores it into normal processing", async () => {
    // A real ticket and our reply in it.
    const real = await ingest(mail({ from: "Kim <kim@example.test>" }));
    const ticketId = real.entry?.ticketId ?? "";
    const [first] = await db().select().from(messages).where(eq(messages.ticketId, ticketId));
    const before = (await getTicket(triager, ticketId)).ticket;
    // Junk from the requester that references the real ticket.
    const junk = await ingest(
      mail({
        from: "Kim <kim@example.test>",
        inReplyTo: first?.receivedMessageId ?? "",
        headers: ["X-Spam-Flag: YES"],
        html: '<p>Win</p><script>alert(1)</script><img src="x" onerror="alert(2)">',
      }),
    );
    expect(junk.outcome).toBe("junk");
    expect(junk.entry).toMatchObject({ state: "junk", ticketId: null });
    expect(junk.entry?.classification).toMatchObject({ verdict: "junk", reason: "spam_flag" });
    const after = await getTicket(triager, ticketId);
    expect(after.ticket.revision).toBe(before.revision);
    expect(after.ticket.status).toBe(before.status);
    expect(after.messages).toHaveLength(1);
    // Listed in junk, with a sanitized preview, for readers of the project only.
    const listed = await listJunk(reader);
    expect(listed.find((item) => item.id === junk.ingressId)).toMatchObject({
      kind: "mail",
      reason: "spam_flag",
      from: "kim@example.test",
      canRestore: false,
    });
    const preview = await getJunkMail(reader, junk.ingressId);
    expect(preview.html).toContain("Win");
    for (const unsafe of ["<script", "onerror"]) expect(preview.html).not.toContain(unsafe);
    await expect(getJunkMail(outsider, junk.ingressId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(listJunk(reader, [otherProject])).rejects.toMatchObject({ code: "not_found" });
    // Restoring needs ticket.junk on the project and a person.
    await expect(restoreJunkMail(reader, junk.ingressId)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      restoreJunkMail({ ...triager, kind: "agent" }, junk.ingressId),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(restoreJunkMail(outsider, junk.ingressId)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await restoreJunkMail(triager, junk.ingressId)).toEqual({ restored: true });
    await expect(restoreJunkMail(triager, junk.ingressId)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      await db()
        .select()
        .from(jobs)
        .where(eq(jobs.dedupKey, `ingest-restore:${junk.ingressId}`)),
    ).toHaveLength(1);
    // Processed again without classification, it now threads into the ticket.
    expect(await processIngress(junk.ingressId)).toBe("appended");
    expect((await getTicket(triager, ticketId)).messages).toHaveLength(2);
    expect((await listJunk(triager)).some((item) => item.id === junk.ingressId)).toBe(false);
  });
});
describe("junk edge cases", () => {
  it("previews mail without HTML or subject and answers not_found outside junk", async () => {
    const { ingressId } = await acceptInbound({
      projectId,
      connectionId: null,
      externalKey: `test:${randomUUID()}`,
      raw: Buffer.from(
        "From: bare@example.test\r\nTo: support@example.test\r\nX-Spam-Status: Yes\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\n\r\n",
      ),
    });
    expect(await processIngress(ingressId)).toBe("junk");
    expect(await getJunkMail(reader, ingressId)).toMatchObject({
      subject: "(no subject)",
      from: "bare@example.test",
      reason: "spam_status",
      attachments: 0,
    });
    expect((await getJunkMail(reader, ingressId)).html).toContain("(no text content)");
    const nobody: Principal = { ...reader, grants: [] };
    expect(await listJunk(nobody)).toEqual([]);
    await expect(getJunkMail(nobody, ingressId)).rejects.toMatchObject({ code: "not_found" });
    await expect(getJunkMail(reader, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await restoreJunkMail(triager, ingressId);
    await expect(getJunkMail(reader, ingressId)).rejects.toMatchObject({ code: "not_found" });
    const { entry } = await ingest(mail({ from: "Mo <mo@example.test>" }));
    await expect(
      moveTicketToJunk({ ...triager, kind: "agent" }, entry?.ticketId ?? ""),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
describe("tickets in junk", () => {
  it("moves a ticket out of the inbox and blocks public replies until restored", async () => {
    const { entry } = await ingest(mail({ from: "Lee <lee@example.test>" }));
    const ticketId = entry?.ticketId ?? "";
    await expect(moveTicketToJunk(reader, ticketId)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(moveTicketToJunk(outsider, ticketId)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await moveTicketToJunk(triager, ticketId)).toEqual({ junk: true });
    await expect(moveTicketToJunk(triager, ticketId)).rejects.toMatchObject({ code: "conflict" });
    expect((await listTickets(triager)).some((ticket) => ticket.id === ticketId)).toBe(false);
    expect((await listJunk(triager)).find((item) => item.id === ticketId)).toMatchObject({
      kind: "ticket",
      reason: "operator",
      canRestore: true,
    });
    const { ticket } = await getTicket(triager, ticketId);
    const answer = {
      markdown: "Answer",
      language: ticket.language,
      expectedRevision: ticket.revision,
      idempotencyKey: randomUUID(),
    };
    await expect(reply(triager, ticketId, answer)).rejects.toMatchObject({ code: "conflict" });
    // A private note is still possible.
    expect(
      (await reply(triager, ticketId, { ...answer, internal: true, idempotencyKey: randomUUID() }))
        .duplicate,
    ).toBe(false);
    expect(await restoreTicket(triager, ticketId)).toEqual({ junk: false });
    await expect(restoreTicket(triager, ticketId)).rejects.toMatchObject({ code: "conflict" });
    expect((await listTickets(triager)).some((entry) => entry.id === ticketId)).toBe(true);
    expect(
      (
        await db().select({ action: audit.action }).from(audit).where(eq(audit.targetId, ticketId))
      ).map((row) => row.action),
    ).toEqual(expect.arrayContaining(["ticket.junk", "ticket.restore"]));
  });
});
