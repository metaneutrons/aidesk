import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { ingress, jobs, messages, projects, tickets } from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import { getTicket } from "../src/server/operations";
import { initializeStorage } from "../src/server/storage";
import { parseDeliveryReport } from "../src/domain/bounce";
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
function report(fields: {
  recipient: string;
  originalId: string | null;
  action?: string;
  type?: string;
  messageId?: string;
}): Buffer {
  return Buffer.from(
    [
      "From: MAILER-DAEMON@mx.example.test",
      "To: support@example.test",
      "Subject: Undelivered Mail Returned to Sender",
      `Message-ID: ${fields.messageId ?? `<${randomUUID()}@mx.example.test>`}`,
      "MIME-Version: 1.0",
      `Content-Type: ${fields.type ?? "multipart/report; report-type=delivery-status"}; boundary="B"`,
      "",
      "--B",
      "Content-Type: text/plain; charset=us-ascii",
      "",
      "This is the mail system.",
      "--B",
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; mx.example.test",
      "",
      `Final-Recipient: rfc822; ${fields.recipient}`,
      `Action: ${fields.action ?? "failed"}`,
      "Status: 5.1.1",
      "Diagnostic-Code: smtp; 550 5.1.1 <alex@example.test>: User unknown",
      "--B",
      "Content-Type: text/rfc822-headers",
      "",
      ...(fields.originalId ? [`Message-ID: ${fields.originalId}`] : []),
      "Subject: Re: Help",
      "--B--",
      "",
    ].join("\r\n"),
  );
}
function mail(fields: { from?: string; messageId?: string }) {
  return Buffer.from(
    [
      `From: ${fields.from ?? "Alex <alex@example.test>"}`,
      "To: support@example.test",
      "Subject: Help",
      `Message-ID: ${fields.messageId ?? `<${randomUUID()}@example.test>`}`,
      "Content-Type: text/plain",
      "",
      "Hello",
      "",
    ].join("\r\n"),
  );
}
async function ingest(raw: Buffer, project: string = projectId) {
  const { ingressId } = await acceptInbound({
    projectId: project,
    connectionId: null,
    externalKey: `test:${randomUUID()}`,
    raw,
  });
  const outcome = await processIngress(ingressId);
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  return { outcome, ticketId: entry?.ticketId ?? "" };
}
// A ticket that we answered: the message is sent, the ticket waits.
async function answered(
  options: {
    project?: string;
    status?: "open" | "waiting" | "resolved";
    kind?: string;
    junk?: boolean;
  } = {},
) {
  const project = options.project ?? projectId;
  const first = await ingest(mail({}), project);
  const outgoing = `<${randomUUID()}@support.example.test>`;
  const [message] = await db()
    .insert(messages)
    .values({
      ticketId: first.ticketId,
      authorType: options.kind === "acknowledgement" ? "system" : "human",
      authorName: "Agent",
      markdown: "Answer",
      language: "en",
      deliveryState: "sent",
      source: { messageId: outgoing, ...(options.kind ? { kind: options.kind } : {}) },
    })
    .returning({ id: messages.id });
  await db()
    .update(tickets)
    .set({
      status: options.status ?? "waiting",
      resolvedAt: options.status === "resolved" ? new Date() : null,
      pendingSince: null,
      junkAt: options.junk ? new Date() : null,
    })
    .where(eq(tickets.id, first.ticketId));
  return { ticketId: first.ticketId, outgoing, messageId: message?.id ?? "" };
}
const ticketRow = async (id: string) =>
  (await db().select().from(tickets).where(eq(tickets.id, id)))[0];
const messageRow = async (id: string) =>
  (await db().select().from(messages).where(eq(messages.id, id)))[0];
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Bounce", slug: `bounce-${projectId}` },
      { id: otherProject, name: "Other", slug: `bounce-${otherProject}` },
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
describe("delivery report parsing", () => {
  const type = { value: "multipart/report", params: { "report-type": "delivery-status" } };
  const status = (action: string, recipient: string) =>
    `Final-Recipient: rfc822; ${recipient}\nAction: ${action}\nStatus: 4.2.2\nDiagnostic-Code: smtp; full`;
  it("reads the failed recipient and the original identifier", () => {
    const text = `Reporting-MTA: dns; mx\n\n${status("delayed", "a@x.test")}\n\n${status("failed", "B@x.test")}`;
    expect(parseDeliveryReport(type, text, ["Message-ID: <a@b.test>\r\nSubject: x"])).toEqual({
      action: "failed",
      status: "4.2.2",
      recipient: "b@x.test",
      diagnostic: "smtp; full",
      originalMessageId: "<a@b.test>",
    });
    expect(parseDeliveryReport(type, status("delayed", "a@x.test"), [])).toMatchObject({
      action: "delayed",
      originalMessageId: null,
    });
  });
  it("accepts only delivery reports with a readable status", () => {
    const text = status("failed", "a@x.test");
    expect(parseDeliveryReport(undefined, text, [])).toBeNull();
    expect(parseDeliveryReport({ value: "text/plain" }, text, [])).toBeNull();
    expect(parseDeliveryReport({ value: "multipart/report", params: {} }, text, [])).toBeNull();
    expect(
      parseDeliveryReport(
        { value: "multipart/report", params: { "report-type": "disposition-notification" } },
        text,
        [],
      ),
    ).toBeNull();
    expect(parseDeliveryReport(type, "No fields here", [])).toBeNull();
    expect(parseDeliveryReport(type, "Action: failed\nStatus: oops", ["Message-ID: nope"])).toEqual(
      {
        action: "failed",
        status: null,
        recipient: null,
        diagnostic: null,
        originalMessageId: null,
      },
    );
  });
});
describe("late bounces", () => {
  it("marks the sent reply and reopens the obligation to answer", async () => {
    const sent = await answered();
    const before = await ticketRow(sent.ticketId);
    const result = await ingest(
      report({ recipient: "alex@example.test", originalId: sent.outgoing }),
    );
    expect(result).toEqual({ outcome: "bounced", ticketId: sent.ticketId });
    expect(await messageRow(sent.messageId)).toMatchObject({
      deliveryState: "review",
      source: {
        messageId: sent.outgoing,
        deliveryError: "bounced",
        bounce: { status: "5.1.1", diagnostic: expect.stringContaining("User unknown") },
      },
    });
    expect(await ticketRow(sent.ticketId)).toMatchObject({
      status: "open",
      revision: (before?.revision ?? 0) + 1,
    });
    expect((await ticketRow(sent.ticketId))?.pendingSince).not.toBeNull();
    // Shown to readers, and no ticket was made from the report.
    const shown = (await getTicket(reader, sent.ticketId)).messages.find(
      (message) => message.id === sent.messageId,
    );
    expect(shown).toMatchObject({ deliveryState: "review", deliveryError: "bounced" });
    expect(
      await db()
        .select()
        .from(tickets)
        .where(
          and(
            eq(tickets.projectId, projectId),
            eq(tickets.subject, "Undelivered Mail Returned to Sender"),
          ),
        ),
    ).toHaveLength(0);
    // A second report about the same failure changes nothing.
    const again = await ingest(
      report({ recipient: "alex@example.test", originalId: sent.outgoing }),
    );
    expect(again.outcome).toBe("report");
    expect((await ticketRow(sent.ticketId))?.revision).toBe((before?.revision ?? 0) + 1);
  });
  it("reopens a ticket that the failed reply had resolved", async () => {
    const sent = await answered({ status: "resolved" });
    await ingest(report({ recipient: "alex@example.test", originalId: sent.outgoing }));
    expect(await ticketRow(sent.ticketId)).toMatchObject({ status: "open", resolvedAt: null });
  });
  it("leaves the ticket alone for an acknowledgement or a ticket in junk", async () => {
    for (const options of [{ kind: "acknowledgement" }, { junk: true }]) {
      const sent = await answered(options);
      const before = await ticketRow(sent.ticketId);
      const result = await ingest(
        report({ recipient: "alex@example.test", originalId: sent.outgoing }),
      );
      expect(result.outcome).toBe("bounced");
      expect((await messageRow(sent.messageId))?.deliveryState).toBe("review");
      expect(await ticketRow(sent.ticketId)).toMatchObject({
        status: "waiting",
        revision: before?.revision,
        pendingSince: null,
      });
    }
  });
  it("only notes a delay", async () => {
    const sent = await answered();
    const result = await ingest(
      report({ recipient: "alex@example.test", originalId: sent.outgoing, action: "delayed" }),
    );
    expect(result.outcome).toBe("report");
    expect((await messageRow(sent.messageId))?.deliveryState).toBe("sent");
    expect((await ticketRow(sent.ticketId))?.status).toBe("waiting");
  });
  it("counter-probe: reports that do not fit our message become ordinary mail", async () => {
    const sent = await answered();
    const other = await answered({ project: otherProject });
    // A message that was never accepted by the transport cannot have bounced.
    const queued = await answered();
    await db()
      .update(messages)
      .set({ deliveryState: "queued" })
      .where(eq(messages.id, queued.messageId));
    const cases = [
      // Another recipient than the one we wrote to.
      report({ recipient: "eve@example.test", originalId: sent.outgoing }),
      // An identifier of ours that does not exist.
      report({
        recipient: "alex@example.test",
        originalId: `<${randomUUID()}@support.example.test>`,
      }),
      // A report without the original identifier.
      report({ recipient: "alex@example.test", originalId: null }),
      // An identifier that belongs to another project.
      report({ recipient: "alex@example.test", originalId: other.outgoing }),
      report({ recipient: "alex@example.test", originalId: queued.outgoing }),
      // The same text without being a delivery report.
      report({
        recipient: "alex@example.test",
        originalId: sent.outgoing,
        type: "multipart/mixed",
      }),
    ];
    for (const raw of cases) {
      const result = await ingest(raw);
      expect(result.outcome).toBe("created");
      expect(result.ticketId).not.toBe(sent.ticketId);
    }
    expect((await messageRow(sent.messageId))?.deliveryState).toBe("sent");
    expect((await messageRow(other.messageId))?.deliveryState).toBe("sent");
    expect((await messageRow(queued.messageId))?.deliveryState).toBe("queued");
    expect((await ticketRow(sent.ticketId))?.status).toBe("waiting");
  });
});
