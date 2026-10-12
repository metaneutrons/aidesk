import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { ingress, jobs, messages, projects, tickets } from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import { getObject, initializeStorage } from "../src/server/storage";
const projectId = randomUUID();
const otherProject = randomUUID();
function mail(fields: {
  from?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  text?: string;
  html?: string;
}): Buffer {
  const headers = [
    ...(fields.from === "" ? [] : [`From: ${fields.from ?? "Alex <alex@example.test>"}`]),
    "To: Support <support@example.test>",
    `Subject: ${fields.subject ?? "Help needed"}`,
    `Message-ID: ${fields.messageId ?? `<${randomUUID()}@example.test>`}`,
    "Date: Mon, 12 Oct 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    ...(fields.inReplyTo ? [`In-Reply-To: ${fields.inReplyTo}`] : []),
    ...(fields.references ? [`References: ${fields.references}`] : []),
    fields.html
      ? "Content-Type: text/html; charset=utf-8"
      : "Content-Type: text/plain; charset=utf-8",
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${fields.html ?? fields.text ?? "Hello"}\r\n`);
}
async function ingest(raw: Buffer, project = projectId) {
  const accepted = await acceptInbound({
    projectId: project,
    connectionId: null,
    externalKey: `test:${randomUUID()}`,
    raw,
  });
  return { ...accepted, outcome: await processIngress(accepted.ingressId) };
}
async function ticketOf(ingressId: string) {
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  const [ticket] = await db()
    .select()
    .from(tickets)
    .where(eq(tickets.id, entry?.ticketId ?? randomUUID()));
  return { entry, ticket };
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Inbound test", slug: `inbound-${projectId}`, defaultLanguage: "de" },
      { id: otherProject, name: "Other", slug: `inbound-${otherProject}` },
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
describe("inbound mail", () => {
  it("stores the original and creates a ticket with the new content", async () => {
    const raw = mail({
      text: "My export fails.\n\nOn Mon, Orbit wrote:\n> earlier text",
      subject: "Export",
    });
    const { ingressId, duplicate, outcome } = await ingest(raw);
    expect({ duplicate, outcome }).toEqual({ duplicate: false, outcome: "created" });
    const { entry, ticket } = await ticketOf(ingressId);
    expect(ticket).toMatchObject({
      subject: "Export",
      requesterEmail: "alex@example.test",
      requesterName: "Alex",
      language: "de",
      status: "open",
    });
    expect(ticket?.pendingSince?.getTime()).toBe(entry?.receivedAt.getTime());
    expect(Buffer.compare(await getObject(entry?.rawObjectKey ?? ""), raw)).toBe(0);
    const [message] = await db()
      .select()
      .from(messages)
      .where(eq(messages.ticketId, ticket?.id ?? ""));
    expect(message).toMatchObject({
      markdown: "My export fails.",
      authorType: "customer",
      deliveryState: "received",
      source: { extraction: "parser", trimmed: true, from: "alex@example.test" },
    });
    expect(await processIngress(ingressId)).toBe("done");
  });
  it("does not duplicate a redelivered message", async () => {
    const key = `test:${randomUUID()}`;
    const raw = mail({ messageId: `<dup-${randomUUID()}@example.test>` });
    const first = await acceptInbound({ projectId, connectionId: null, externalKey: key, raw });
    expect(await acceptInbound({ projectId, connectionId: null, externalKey: key, raw })).toEqual({
      ingressId: first.ingressId,
      duplicate: true,
    });
    expect(
      await db()
        .select()
        .from(jobs)
        .where(eq(jobs.dedupKey, `ingest:${first.ingressId}`)),
    ).toHaveLength(1);
    expect(await processIngress(first.ingressId)).toBe("created");
    // The same Message-ID through another delivery path (new external key).
    const again = await ingest(raw);
    expect(again.outcome).toBe("duplicate");
    const { ticket } = await ticketOf(first.ingressId);
    expect(
      await db()
        .select()
        .from(messages)
        .where(eq(messages.ticketId, ticket?.id ?? "")),
    ).toHaveLength(1);
    // A Message-ID seen in another project is not a duplicate here.
    expect((await ingest(raw, otherProject)).outcome).toBe("created");
  });
  it("threads a requester's reply to our message and reopens the obligation", async () => {
    const first = await ingest(mail({ text: "Question" }));
    const { ticket } = await ticketOf(first.ingressId);
    const outgoing = `<${randomUUID()}@support.example.test>`;
    await db()
      .insert(messages)
      .values({
        ticketId: ticket?.id ?? "",
        authorType: "human",
        authorName: "Agent",
        markdown: "Answer",
        language: "de",
        deliveryState: "sent",
        source: { messageId: outgoing },
      });
    await db()
      .update(tickets)
      .set({ status: "waiting", pendingSince: null })
      .where(eq(tickets.id, ticket?.id ?? ""));
    const reply = await ingest(
      mail({
        subject: "Re: Help needed",
        inReplyTo: outgoing,
        references: outgoing,
        text: "Thanks!",
      }),
    );
    expect(reply.outcome).toBe("appended");
    const after = (await ticketOf(reply.ingressId)).ticket;
    expect(after?.id).toBe(ticket?.id);
    expect(after?.status).toBe("open");
    expect(after?.pendingSince).not.toBeNull();
    expect(after?.revision).toBe((ticket?.revision ?? 0) + 1);
    // The same reference from someone else starts a separate ticket.
    const stranger = await ingest(
      mail({ from: "Eve <eve@example.test>", inReplyTo: outgoing, text: "Show me the thread" }),
    );
    expect(stranger.outcome).toBe("created");
    expect((await ticketOf(stranger.ingressId)).ticket?.id).not.toBe(ticket?.id);
  });
  it("reopens recently resolved tickets and links later follow-ups", async () => {
    const recent = await ingest(mail({ text: "First" }));
    const recentTicket = (await ticketOf(recent.ingressId)).ticket;
    const parsed = (await ticketOf(recent.ingressId)).entry?.parsed as { messageId: string };
    await db()
      .update(tickets)
      .set({
        status: "resolved",
        resolvedAt: new Date(Date.now() - 86_400_000),
        pendingSince: null,
      })
      .where(eq(tickets.id, recentTicket?.id ?? ""));
    const reopened = await ingest(mail({ inReplyTo: parsed.messageId, text: "Again" }));
    expect(reopened.outcome).toBe("reopened");
    expect((await ticketOf(reopened.ingressId)).ticket).toMatchObject({
      status: "open",
      resolvedAt: null,
    });
    await db()
      .update(tickets)
      .set({ status: "resolved", resolvedAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(eq(tickets.id, recentTicket?.id ?? ""));
    const later = await ingest(mail({ inReplyTo: parsed.messageId, text: "Much later" }));
    expect(later.outcome).toBe("follow_up");
    const followUp = (await ticketOf(later.ingressId)).ticket;
    expect(followUp?.id).not.toBe(recentTicket?.id);
    const [message] = await db()
      .select()
      .from(messages)
      .where(eq(messages.ticketId, followUp?.id ?? ""));
    expect(message?.source).toMatchObject({ followUpOf: recentTicket?.id });
  });
  it("converts HTML-only mail and rejects unusable input", async () => {
    const html = await ingest(mail({ html: "<p>Steps:</p><ol><li>Open</li><li>Save</li></ol>" }));
    const { ticket } = await ticketOf(html.ingressId);
    const [message] = await db()
      .select()
      .from(messages)
      .where(eq(messages.ticketId, ticket?.id ?? ""));
    expect(message?.markdown).toMatch(/1\.\s+Open\n2\.\s+Save/);
    const anonymous = await acceptInbound({
      projectId,
      connectionId: null,
      externalKey: `test:${randomUUID()}`,
      raw: mail({ from: "" }),
    });
    await expect(processIngress(anonymous.ingressId)).rejects.toThrow("inbound_sender_missing");
    const [entry] = await db().select().from(ingress).where(eq(ingress.id, anonymous.ingressId));
    expect(entry?.state).toBe("review");
    await expect(
      acceptInbound({
        projectId,
        connectionId: null,
        externalKey: "test:empty",
        raw: Buffer.alloc(0),
      }),
    ).rejects.toThrow("inbound_size");
    await expect(processIngress(randomUUID())).rejects.toThrow("ingress_missing");
  });
  it("handles mail without Message-ID, subject or text", async () => {
    const raw = Buffer.from(
      "From: bare@example.test\r\nTo: support@example.test\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\n\r\n",
    );
    const { ingressId, outcome } = await ingest(raw);
    expect(outcome).toBe("created");
    const { entry, ticket } = await ticketOf(ingressId);
    expect(ticket).toMatchObject({ subject: "(no subject)", requesterName: "bare@example.test" });
    expect(entry?.parsed).toMatchObject({ messageId: null, references: [] });
    const [message] = await db()
      .select()
      .from(messages)
      .where(eq(messages.ticketId, ticket?.id ?? ""));
    expect(message).toMatchObject({ markdown: "(no text content)", receivedMessageId: null });
  });
});
