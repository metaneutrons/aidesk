import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { eq, inArray } from "drizzle-orm";
import type { Principal } from "../src/domain/permissions";
import { restoreJunkMail } from "../src/server/operations";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, ingress, jobs, messages, projects, tickets } from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import { initializeStorage } from "../src/server/storage";
const projectId = randomUUID();
const otherProject = randomUUID();
const day = 86_400_000;
function mail(fields: {
  from?: string;
  messageId?: string;
  date?: string;
  inReplyTo?: string;
  references?: string;
}): Buffer {
  const headers = [
    `From: ${fields.from ?? "Alex <alex@example.test>"}`,
    "To: Support <support@example.test>",
    "Subject: Lifecycle",
    `Message-ID: ${fields.messageId ?? `<${randomUUID()}@example.test>`}`,
    ...(fields.date ? [`Date: ${fields.date}`] : []),
    "MIME-Version: 1.0",
    ...(fields.inReplyTo ? [`In-Reply-To: ${fields.inReplyTo}`] : []),
    ...(fields.references ? [`References: ${fields.references}`] : []),
    "Content-Type: text/plain; charset=utf-8",
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\nHello\r\n`);
}
// Accepts a mail and lets the test choose the server's receipt time before the
// mail is processed.
async function accept(raw: Buffer, options: { project?: string; at?: Date } = {}) {
  const accepted = await acceptInbound({
    projectId: options.project ?? projectId,
    connectionId: null,
    externalKey: `test:${randomUUID()}`,
    raw,
  });
  if (options.at)
    await db()
      .update(ingress)
      .set({ receivedAt: options.at })
      .where(eq(ingress.id, accepted.ingressId));
  return accepted.ingressId;
}
async function ingest(raw: Buffer, options: { project?: string; at?: Date } = {}) {
  const ingressId = await accept(raw, options);
  const outcome = await processIngress(ingressId);
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  const [ticket] = await db()
    .select()
    .from(tickets)
    .where(eq(tickets.id, entry?.ticketId ?? randomUUID()));
  const conversation = await db()
    .select()
    .from(messages)
    .where(eq(messages.ticketId, ticket?.id ?? randomUUID()))
    .orderBy(messages.createdAt);
  return { ingressId, outcome, entry, ticket, conversation };
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Lifecycle", slug: `lifecycle-${projectId}` },
      { id: otherProject, name: "Other", slug: `lifecycle-${otherProject}` },
    ]);
});
afterAll(async () => {
  const ids = [projectId, otherProject];
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(ingress).where(inArray(ingress.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("receipt clock", () => {
  it("takes the receipt time from the server and never from the Date header", async () => {
    for (const date of ["Mon, 01 Jan 2001 00:00:00 +0000", "Fri, 01 Jan 2100 00:00:00 +0000"]) {
      const result = await ingest(mail({ date }));
      expect(result.outcome).toBe("created");
      const received = result.entry?.receivedAt.getTime() ?? 0;
      expect(Math.abs(received - Date.now())).toBeLessThan(60_000);
      expect(result.conversation[0]?.createdAt.getTime()).toBe(received);
      expect(result.ticket?.pendingSince?.getTime()).toBe(received);
    }
  });
  it("keeps the start of the cycle when the customer writes again before an answer", async () => {
    const first = await ingest(mail({}), { at: new Date(Date.now() - 5 * 3_600_000) });
    const second = await ingest(
      mail({ inReplyTo: first.conversation[0]?.receivedMessageId ?? "" }),
      { at: new Date(Date.now() - 1 * 3_600_000) },
    );
    expect(second.ticket?.id).toBe(first.ticket?.id);
    expect(second.conversation).toHaveLength(2);
    expect(second.ticket?.pendingSince?.getTime()).toBe(first.ticket?.pendingSince?.getTime());
  });
  it("counter-probe: the stored receipt time is what the ticket follows", async () => {
    const at = new Date(Date.now() - 3 * day);
    const result = await ingest(mail({ date: "Fri, 01 Jan 2100 00:00:00 +0000" }), { at });
    expect(result.conversation[0]?.createdAt.getTime()).toBe(at.getTime());
    expect(result.ticket?.pendingSince?.getTime()).toBe(at.getTime());
  });
});
describe("reopen boundary", () => {
  async function resolved(resolvedAt: Date | null) {
    const first = await ingest(mail({}));
    await db()
      .update(tickets)
      .set({ status: "resolved", resolvedAt, pendingSince: null })
      .where(eq(tickets.id, first.ticket?.id ?? ""));
    return first;
  }
  it("reopens at exactly 30 days and links a follow-up one millisecond later", async () => {
    const at = new Date();
    const edge = await resolved(new Date(at.getTime() - 30 * day));
    const reopened = await ingest(
      mail({ inReplyTo: edge.conversation[0]?.receivedMessageId ?? "" }),
      {
        at,
      },
    );
    expect(reopened.outcome).toBe("reopened");
    expect(reopened.ticket).toMatchObject({
      id: edge.ticket?.id,
      status: "open",
      resolvedAt: null,
    });
    const late = await resolved(new Date(at.getTime() - 30 * day - 1));
    const followUp = await ingest(
      mail({ inReplyTo: late.conversation[0]?.receivedMessageId ?? "" }),
      {
        at,
      },
    );
    expect(followUp.outcome).toBe("follow_up");
    expect(followUp.ticket?.id).not.toBe(late.ticket?.id);
    expect(followUp.conversation[0]?.source).toMatchObject({ followUpOf: late.ticket?.id });
    expect((await ingest(mail({}), { at })).outcome).toBe("created");
  });
  it("treats a resolved ticket without a resolution time as long closed", async () => {
    const first = await resolved(null);
    const result = await ingest(
      mail({ inReplyTo: first.conversation[0]?.receivedMessageId ?? "" }),
    );
    expect(result.outcome).toBe("follow_up");
  });
});
describe("the policy of the project for a reply to a resolved ticket", () => {
  const setPolicy = (settings: Record<string, unknown>) =>
    db().update(projects).set({ settings }).where(eq(projects.id, projectId));
  const person: Principal = {
    id: `policy-${projectId}`,
    kind: "human",
    active: true,
    owner: false,
    grants: [{ projectId, actions: ["project.read", "ticket.read", "ticket.junk"] }],
  };
  async function resolvedAgo(ms: number, at: Date) {
    const first = await ingest(mail({}));
    await db()
      .update(tickets)
      .set({ status: "resolved", resolvedAt: new Date(at.getTime() - ms), pendingSince: null })
      .where(eq(tickets.id, first.ticket?.id ?? ""));
    return first;
  }
  const replyTo = (first: Awaited<ReturnType<typeof resolvedAgo>>, at: Date) =>
    ingest(mail({ inReplyTo: first.conversation[0]?.receivedMessageId ?? "" }), { at });
  afterEach(() => setPolicy({}));
  it("reopens within the days that the project sets and links a follow-up after them", async () => {
    await setPolicy({ reopenMode: "reopen", reopenDays: 7 });
    const at = new Date();
    const edge = await resolvedAgo(7 * day, at);
    expect((await replyTo(edge, at)).outcome).toBe("reopened");
    const late = await resolvedAgo(7 * day + 1, at);
    const followUp = await replyTo(late, at);
    expect(followUp.outcome).toBe("follow_up");
    expect(followUp.ticket?.id).not.toBe(late.ticket?.id);
  });
  it("reopens after a long window that the project sets, which the old constant would not", async () => {
    await setPolicy({ reopenMode: "reopen", reopenDays: 365 });
    const at = new Date();
    const old = await resolvedAgo(200 * day, at);
    expect((await replyTo(old, at)).outcome).toBe("reopened");
  });
  it("starts a linked new ticket and leaves the old one resolved when the mode is new_ticket", async () => {
    await setPolicy({ reopenMode: "new_ticket", reopenDays: 30 });
    const at = new Date();
    const recent = await resolvedAgo(1 * day, at);
    const result = await replyTo(recent, at);
    expect(result.outcome).toBe("follow_up");
    expect(result.ticket?.id).not.toBe(recent.ticket?.id);
    expect(result.conversation[0]?.source).toMatchObject({ followUpOf: recent.ticket?.id });
    const [old] = await db()
      .select()
      .from(tickets)
      .where(eq(tickets.id, recent.ticket?.id ?? ""));
    expect(old).toMatchObject({ status: "resolved" });
  });
  it("keeps a reply out as junk with a reason when the mode is refuse, and a person can restore it", async () => {
    await setPolicy({ reopenMode: "refuse", reopenDays: 30 });
    const at = new Date();
    const recent = await resolvedAgo(1 * day, at);
    const refused = await replyTo(recent, at);
    expect(refused.outcome).toBe("junk");
    expect(refused.ticket).toBeUndefined();
    expect(refused.entry).toMatchObject({
      state: "junk",
      classification: { verdict: "junk", reason: "reply_to_resolved", source: "rules" },
    });
    const [old] = await db()
      .select()
      .from(tickets)
      .where(eq(tickets.id, recent.ticket?.id ?? ""));
    expect(old).toMatchObject({ status: "resolved" });
    // Restored, it is taken like a reply that reopens within the window, and not refused a second time.
    await restoreJunkMail(person, refused.ingressId);
    await processIngress(refused.ingressId);
    const [after] = await db().select().from(ingress).where(eq(ingress.id, refused.ingressId));
    expect(after?.state).not.toBe("junk");
    expect(
      (
        await db()
          .select()
          .from(tickets)
          .where(eq(tickets.id, recent.ticket?.id ?? ""))
      )[0],
    ).toMatchObject({
      status: "open",
    });
  });
  it("does not refuse a reply to a ticket that is not resolved", async () => {
    await setPolicy({ reopenMode: "refuse", reopenDays: 30 });
    const open = await ingest(mail({}));
    const reply = await ingest(mail({ inReplyTo: open.conversation[0]?.receivedMessageId ?? "" }));
    expect(reply.outcome).toBe("appended");
    expect(reply.ticket?.id).toBe(open.ticket?.id);
  });
  it("does not let a mail of another project or another sender reach the policy of this one", async () => {
    await setPolicy({ reopenMode: "refuse", reopenDays: 30 });
    const at = new Date();
    const recent = await resolvedAgo(1 * day, at);
    // Another sender with the reference: not a reply to this ticket, so a ticket of its own.
    const stranger = await ingest(
      mail({
        from: "Stranger <stranger@example.test>",
        inReplyTo: recent.conversation[0]?.receivedMessageId ?? "",
      }),
      { at },
    );
    expect(stranger.outcome).toBe("created");
  });
});
describe("suspicious threading", () => {
  it("starts a new ticket for references that do not lead to a ticket of the sender", async () => {
    const own = await ingest(mail({}));
    const ownId = own.conversation[0]?.receivedMessageId ?? "";
    const cases = [
      // Well-formed identifiers that exist nowhere.
      { references: `<${randomUUID()}@example.test> <${randomUUID()}@example.test>` },
      // An injected header line is not part of References.
      { references: `<x@example.test>\r\nBcc: eve@example.test ${ownId.slice(1, -1)}` },
      // A near miss of a real identifier is a different identifier.
      { inReplyTo: `<${ownId.slice(2)}` },
    ];
    for (const fields of cases) {
      const result = await ingest(mail(fields));
      expect(result.outcome, JSON.stringify(fields)).toBe("created");
      expect(result.ticket?.id).not.toBe(own.ticket?.id);
      expect(result.conversation[0]?.source).not.toHaveProperty("followUpOf");
    }
    // The same requester referencing the ticket still reaches it.
    const reply = await ingest(mail({ inReplyTo: ownId }));
    expect(reply.outcome).toBe("appended");
    expect(reply.ticket?.id).toBe(own.ticket?.id);
  });
  it("does not follow a reference into another project", async () => {
    const elsewhere = await ingest(mail({}), { project: otherProject });
    const claimed = elsewhere.conversation[0]?.receivedMessageId ?? "";
    const result = await ingest(mail({ inReplyTo: claimed, references: claimed }));
    expect(result.outcome).toBe("created");
    expect(result.ticket?.projectId).toBe(projectId);
    expect(result.ticket?.id).not.toBe(elsewhere.ticket?.id);
    // Counter-probe: the same reference inside that project does thread.
    const inside = await ingest(mail({ inReplyTo: claimed }), { project: otherProject });
    expect(inside.outcome).toBe("appended");
    expect(inside.ticket?.id).toBe(elsewhere.ticket?.id);
  });
  it("compares the sender's address without regard to case", async () => {
    const first = await ingest(mail({ from: "Alex <alex@example.test>" }));
    const reply = await ingest(
      mail({
        from: "ALEX <ALEX@Example.TEST>",
        inReplyTo: first.conversation[0]?.receivedMessageId ?? "",
      }),
    );
    expect(reply.outcome).toBe("appended");
    expect(reply.ticket?.id).toBe(first.ticket?.id);
  });
});
describe("concurrent processing", () => {
  it("creates one ticket when the same Message-ID arrives twice at once", async () => {
    const raw = mail({});
    const [first, second] = await Promise.all([accept(raw), accept(raw)]);
    const outcomes = await Promise.all([processIngress(first), processIngress(second)]);
    expect([...outcomes].sort()).toEqual(["created", "duplicate"]);
    const entries = await db()
      .select()
      .from(ingress)
      .where(inArray(ingress.id, [first, second]));
    const ticketIds = new Set(entries.map((entry) => entry.ticketId));
    expect(ticketIds.size).toBe(1);
    expect(
      await db()
        .select()
        .from(messages)
        .where(eq(messages.ticketId, [...ticketIds][0] ?? "")),
    ).toHaveLength(1);
  });
  it("waits for the project lock instead of deciding on a stale view", async () => {
    const id = await accept(mail({}));
    let finished = false;
    let processing: Promise<unknown> = Promise.resolve();
    await sqlClient().begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`ingest:${projectId}`}))`;
      processing = processIngress(id).then((outcome) => {
        finished = true;
        return outcome;
      });
      await delay(400);
      expect(finished).toBe(false);
    });
    expect(await processing).toBe("created");
    // Another project's lock does not hold it back.
    const other = await accept(mail({}));
    await sqlClient().begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`ingest:${otherProject}`}))`;
      expect(await processIngress(other)).toBe("created");
    });
  });
  it("processes one ingress record once, however many workers pick it up", async () => {
    const id = await accept(mail({}));
    const outcomes = await Promise.all([
      processIngress(id),
      processIngress(id),
      processIngress(id),
    ]);
    expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "done")).toHaveLength(2);
  });
  it("keeps every message of simultaneous replies and counts each revision", async () => {
    const first = await ingest(mail({}));
    const parent = first.conversation[0]?.receivedMessageId ?? "";
    const ids = await Promise.all(
      Array.from({ length: 4 }, () => accept(mail({ inReplyTo: parent }))),
    );
    const outcomes = await Promise.all(ids.map((id) => processIngress(id)));
    expect(outcomes.every((outcome) => outcome === "appended")).toBe(true);
    const [ticket] = await db()
      .select()
      .from(tickets)
      .where(eq(tickets.id, first.ticket?.id ?? ""));
    expect(ticket?.revision).toBe((first.ticket?.revision ?? 0) + 4);
    expect(
      await db()
        .select()
        .from(messages)
        .where(eq(messages.ticketId, first.ticket?.id ?? "")),
    ).toHaveLength(5);
  });
});
