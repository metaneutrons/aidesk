import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import MailComposer from "nodemailer/lib/mail-composer";
import { db, sqlClient } from "../src/server/db";
import {
  agentRuns,
  agents,
  attachments,
  audit,
  connections,
  ingress,
  issueDrafts,
  jobs,
  messages,
  participants,
  projectExports,
  projects,
  ticketIssues,
  tickets,
  translations,
} from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import {
  eraseRequester,
  eraseTicket,
  previewRequesterErasure,
  previewTicketErasure,
} from "../src/server/erasure";
import { getObject, initializeStorage } from "../src/server/storage";
import { erasureCounts, erasureConfirm, requesterQuery } from "../src/domain/erasure";
import { operatorRoles } from "../src/domain/roles";
import { actions, type Action, type Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectId = randomUUID();
const otherProject = randomUUID();
const eraser = (held: Action[], project = projectId): Principal => ({
  id: `eraser-${run}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId: project, actions: held }],
});
const canErase = eraser(["project.read", "ticket.read", "data.erase"]);
const noErase = eraser(["project.read", "ticket.read", "ticket.reply", "config.read"]);
const outsider = eraser(["data.erase"], otherProject);
const everything = eraser([...operatorRoles.manage]);
let agentId = "";
let connectionId = "";
const shared = Buffer.from(`shared attachment ${run}`);
const own = (name: string) => Buffer.from(`${name} ${run}`);
async function compose(
  from: string,
  subject: string,
  files: { filename: string; content: Buffer }[],
  headers: Record<string, string> = {},
) {
  return new MailComposer({
    from: `Person <${from}>`,
    to: "support@example.test",
    subject,
    text: "Hello",
    messageId: `<${randomUUID()}@example.test>`,
    headers,
    attachments: files,
  })
    .compile()
    .build();
}
async function arrive(
  from: string,
  subject: string,
  files: { filename: string; content: Buffer }[] = [],
  headers: Record<string, string> = {},
) {
  const { ingressId } = await acceptInbound({
    projectId,
    connectionId: null,
    externalKey: `test:${randomUUID()}`,
    raw: await compose(from, subject, files, headers),
  });
  const outcome = await processIngress(ingressId);
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  return { ingressId, outcome, ticketId: entry?.ticketId ?? "" };
}
const countOf = async (table: typeof tickets | typeof messages, where: ReturnType<typeof eq>) =>
  (await db().select().from(table).where(where)).length;
const keyOf = async (ticketId: string) => {
  const [message] = await db().select().from(messages).where(eq(messages.ticketId, ticketId));
  const [file] = message
    ? await db().select().from(attachments).where(eq(attachments.messageId, message.id))
    : [];
  return {
    original: message?.rawObjectKey ?? "",
    file: file?.objectKey ?? "",
    messageId: message?.id ?? "",
  };
};
const exists = (key: string) =>
  getObject(key).then(
    () => true,
    () => false,
  );
const clear = async () => {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(ingress).where(eq(ingress.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(projectExports).where(eq(projectExports.projectId, projectId));
};
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Erasure", slug: `erase-${run}` },
      { id: otherProject, name: "Other", slug: `erase-other-${run}` },
    ]);
  const [agent] = await db()
    .insert(agents)
    .values({
      name: "Erasing agent",
      projectId,
      actions: ["ticket.read"],
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
      managed: true,
    })
    .returning({ id: agents.id });
  agentId = agent?.id ?? "";
  const [connection] = await db()
    .insert(connections)
    .values({
      projectId,
      kind: "github",
      direction: "knowledge",
      name: "Issues",
      config: {},
      status: "ready",
    })
    .returning({ id: connections.id });
  connectionId = connection?.id ?? "";
}, 60_000);
afterAll(async () => {
  await clear();
  await db().delete(agents).where(eq(agents.projectId, projectId));
  await db().delete(connections).where(eq(connections.projectId, projectId));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProject]));
  await sqlClient().end();
});
describe("who may erase", () => {
  it("is an action that no preset holds", () => {
    expect(actions).toContain("data.erase");
    for (const preset of Object.values(operatorRoles)) expect(preset).not.toContain("data.erase");
    expect(everything.grants[0]?.actions).not.toContain("data.erase");
  });
  it("needs data.erase in the project, and a person", async () => {
    await clear();
    const one = await arrive("kim@example.test", "Mine");
    for (const call of [
      () => previewTicketErasure(noErase, one.ticketId),
      () => previewTicketErasure(outsider, one.ticketId),
      () => previewRequesterErasure(noErase, projectId, { email: "kim@example.test" }),
      () => previewRequesterErasure(outsider, projectId, { email: "kim@example.test" }),
    ])
      await expect(call()).rejects.toMatchObject({ code: "not_found" });
    const counts = (await previewTicketErasure(canErase, one.ticketId)).counts;
    for (const call of [
      () => eraseTicket({ ...canErase, kind: "agent" }, one.ticketId, { expected: counts }),
      () => eraseTicket({ ...canErase, active: false }, one.ticketId, { expected: counts }),
      () =>
        eraseRequester({ ...canErase, kind: "agent" }, projectId, {
          email: "kim@example.test",
          expected: counts,
        }),
    ])
      await expect(call()).rejects.toMatchObject({ code: "forbidden" });
    await expect(eraseTicket(noErase, one.ticketId, { expected: counts })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(previewTicketErasure(canErase, randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await countOf(tickets, eq(tickets.id, one.ticketId))).toBe(1);
  });
  it("reads the confirmation and the address in their form", () => {
    expect(erasureConfirm.safeParse({ expected: { tickets: 1 } }).success).toBe(false);
    expect(requesterQuery.parse({ email: "  Kim@Example.TEST " }).email).toBe("kim@example.test");
    expect(requesterQuery.safeParse({ email: "not an address" }).success).toBe(false);
    expect(erasureCounts.safeParse({ tickets: -1 }).success).toBe(false);
  });
});
describe("erasing a ticket", () => {
  it("removes the rows and the files of the ticket, keeps what another ticket shares, and says what is out of reach", async () => {
    await clear();
    const mine = await arrive("kim@example.test", "Mine", [
      { filename: "own.txt", content: own("own") },
      { filename: "shared.txt", content: shared },
    ]);
    const other = await arrive("lee@example.test", "Other", [
      { filename: "shared.txt", content: shared },
    ]);
    const mineKeys = await keyOf(mine.ticketId);
    const otherKeys = await keyOf(other.ticketId);
    // A translation, a portal record, an issue link, a draft of an issue and a run.
    await db().insert(translations).values({
      messageId: mineKeys.messageId,
      sourceRevision: 1,
      language: "de",
      markdown: "Hallo",
      status: "ready",
    });
    await db().insert(participants).values({ ticketId: mine.ticketId, email: "kim@example.test" });
    await db().insert(ticketIssues).values({
      ticketId: mine.ticketId,
      projectId,
      connectionId,
      repository: "acme/app",
      number: 1,
      url: "https://git.example.test/1",
      title: "Linked",
      linkedBy: "x",
      origin: "created",
    });
    await db()
      .insert(issueDrafts)
      .values({
        ticketId: mine.ticketId,
        projectId,
        connectionId,
        repository: "acme/app",
        title: "Draft",
        body: "b",
        createdBy: "x",
      } as never);
    await db()
      .insert(agentRuns)
      .values({
        projectId,
        ticketId: mine.ticketId,
        agentId,
        revision: 1,
        currentRevision: 1,
        trigger: "message",
        state: "queued",
      } as never);
    // A queued mail and a delivered event of the ticket, and an event of the other ticket.
    await db()
      .insert(jobs)
      .values([
        {
          projectId,
          type: "mail.send",
          dedupKey: `m:${randomUUID()}`,
          payload: { ticketId: mine.ticketId },
        },
        {
          projectId,
          type: "webhook.deliver",
          dedupKey: `w:${randomUUID()}`,
          status: "succeeded",
          payload: { event: { type: "ticket.created", data: { ticketId: mine.ticketId } } },
        },
        {
          projectId,
          type: "webhook.deliver",
          dedupKey: `w:${randomUUID()}`,
          payload: { event: { type: "ticket.created", data: { ticketId: other.ticketId } } },
        },
      ]);
    await db()
      .insert(audit)
      .values([
        {
          projectId,
          actorId: "x",
          action: "ticket.tags",
          targetId: mine.ticketId,
          detail: { tags: ["private"] },
        },
        {
          projectId,
          actorId: "x",
          action: "ticket.tags",
          targetId: other.ticketId,
          detail: { tags: ["kept"] },
        },
      ]);
    await db()
      .insert(projectExports)
      .values({
        projectId,
        projectName: "Erasure",
        digest: "d",
        bytes: 1,
        counts: {},
        objectKey: `exports/${projectId}/${run}.zip`,
        createdBy: "x",
      });
    const files = await db()
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, mineKeys.messageId));
    const ownKey = files.find((file) => file.filename === "own.txt")?.objectKey ?? "";
    const sharedKey = files.find((file) => file.filename === "shared.txt")?.objectKey ?? "";
    expect(ownKey).not.toBe("");
    const preview = await previewTicketErasure(canErase, mine.ticketId);
    expect(preview.counts).toEqual({
      tickets: 1,
      messages: 1,
      attachments: 2,
      originals: 1,
      translations: 1,
      issueLinks: 2,
      portalRecords: 1,
      runs: 1,
      // The queued mail, the delivered event, and the job that read the incoming mail.
      jobs: 3,
      ingress: 1,
    });
    expect(preview.outOfReach).toEqual({ webhookEvents: 1, issuesCreated: 1, exports: 1 });
    expect(preview.tickets.map((entry) => entry.subject)).toEqual(["Mine"]);
    // Nothing happens before the confirmation.
    expect(await countOf(tickets, eq(tickets.id, mine.ticketId))).toBe(1);
    const result = await eraseTicket(canErase, mine.ticketId, { expected: preview.counts });
    expect(result.counts).toEqual(preview.counts);
    expect(result.outOfReach).toEqual(preview.outOfReach);
    expect(result.objects).toMatchObject({ failed: 0 });
    expect(await countOf(tickets, eq(tickets.id, mine.ticketId))).toBe(0);
    expect(await countOf(messages, eq(messages.id, mineKeys.messageId))).toBe(0);
    const byMessage = (table: typeof translations | typeof attachments) =>
      db().select().from(table).where(eq(table.messageId, mineKeys.messageId));
    const byTicket = (
      table: typeof participants | typeof ticketIssues | typeof issueDrafts | typeof agentRuns,
    ) => db().select().from(table).where(eq(table.ticketId, mine.ticketId));
    expect(await byMessage(translations)).toEqual([]);
    expect(await byMessage(attachments)).toEqual([]);
    for (const table of [participants, ticketIssues, issueDrafts, agentRuns] as const)
      expect(await byTicket(table)).toEqual([]);
    expect(await db().select().from(ingress).where(eq(ingress.id, mine.ingressId))).toEqual([]);
    // The files: the original and the own file are gone, the shared file stays for the other ticket.
    expect(await exists(mineKeys.original)).toBe(false);
    expect(await exists(ownKey)).toBe(false);
    expect(await exists(sharedKey)).toBe(true);
    expect(sharedKey).toBe(otherKeys.file);
    expect(result.objects.shared).toBe(1);
    expect(result.objects.removed).toBe(2);
    // The other ticket and its event are untouched; the audit entries of the erased one lost their detail.
    expect(await countOf(tickets, eq(tickets.id, other.ticketId))).toBe(1);
    const remaining = await db().select().from(jobs).where(eq(jobs.projectId, projectId));
    expect(remaining.filter((job) => job.type === "webhook.deliver")).toHaveLength(1);
    expect(remaining.some((job) => job.type === "mail.send")).toBe(false);
    const entries = await db().select().from(audit).where(eq(audit.projectId, projectId));
    expect(entries.find((entry) => entry.targetId === mine.ticketId)?.detail).toEqual({});
    expect(entries.find((entry) => entry.targetId === other.ticketId)?.detail).toEqual({
      tags: ["kept"],
    });
    const made = entries.find((entry) => entry.action === "data.erase");
    expect(made).toMatchObject({
      actorId: canErase.id,
      detail: { scope: "ticket", counts: preview.counts },
    });
  });
  it("is a conflict when the numbers are no longer the ones that were shown, and removes nothing", async () => {
    await clear();
    const one = await arrive("kim@example.test", "Count");
    const preview = await previewTicketErasure(canErase, one.ticketId);
    await db().insert(participants).values({ ticketId: one.ticketId, email: "late@example.test" });
    await expect(
      eraseTicket(canErase, one.ticketId, { expected: preview.counts }),
    ).rejects.toMatchObject({ code: "stale_version", status: 409 });
    expect(await countOf(tickets, eq(tickets.id, one.ticketId))).toBe(1);
    const fresh = await previewTicketErasure(canErase, one.ticketId);
    expect(fresh.counts.portalRecords).toBe(1);
    await eraseTicket(canErase, one.ticketId, { expected: fresh.counts });
    expect(await countOf(tickets, eq(tickets.id, one.ticketId))).toBe(0);
  });
});
describe("erasing everything about a requester", () => {
  it("removes their tickets, their portal records and the mail that no ticket holds, and nobody else's", async () => {
    await clear();
    const a = await arrive("Kim@Example.test", "First", [{ filename: "a.txt", content: own("a") }]);
    const b = await arrive("kim@example.test", "Second");
    const lee = await arrive("lee@example.test", "Lee");
    const junk = await arrive("kim@example.test", "Offer", [], { "X-Spam-Flag": "YES" });
    expect(junk.outcome).toBe("junk");
    const note = await arrive("lee@example.test", "Copy");
    // A worker of another test file may have answered these tickets by now, which gives the requester a portal record.
    // The count below is about the one record that this test adds.
    await db().delete(jobs).where(eq(jobs.projectId, projectId));
    await db()
      .delete(participants)
      .where(inArray(participants.ticketId, [a.ticketId, b.ticketId, lee.ticketId, note.ticketId]));
    await db().insert(participants).values({ ticketId: lee.ticketId, email: "kim@example.test" });
    const aKeys = await keyOf(a.ticketId);
    const preview = await previewRequesterErasure(canErase, projectId, {
      email: "  KIM@example.test ",
    });
    expect(preview.counts).toMatchObject({
      tickets: 2,
      messages: 2,
      attachments: 1,
      originals: 3,
      portalRecords: 1,
      ingress: 3,
    });
    expect(preview.tickets.map((entry) => entry.subject).sort()).toEqual(["First", "Second"]);
    const result = await eraseRequester(canErase, projectId, {
      email: "kim@example.test",
      expected: preview.counts,
    });
    expect(result.counts).toEqual(preview.counts);
    for (const gone of [a.ticketId, b.ticketId])
      expect(await countOf(tickets, eq(tickets.id, gone))).toBe(0);
    expect((await db().select().from(ingress).where(eq(ingress.id, junk.ingressId))).length).toBe(
      0,
    );
    expect(await exists(aKeys.file)).toBe(false);
    expect(await countOf(tickets, eq(tickets.id, lee.ticketId))).toBe(1);
    expect(await countOf(tickets, eq(tickets.id, note.ticketId))).toBe(1);
    expect(
      (await db().select().from(participants).where(eq(participants.ticketId, lee.ticketId)))
        .length,
    ).toBe(0);
    // The audit keeps a digest of the address, never the address.
    const entry = (await db().select().from(audit).where(eq(audit.projectId, projectId))).find(
      (row) => row.action === "data.erase",
    );
    expect(entry?.detail).toMatchObject({
      scope: "requester",
      requester: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(entry)).not.toContain("kim@example.test");
  });
  it("says nothing was found for an address without data, and removes nothing", async () => {
    await clear();
    const keep = await arrive("lee@example.test", "Keep");
    const preview = await previewRequesterErasure(canErase, projectId, {
      email: "nobody@example.test",
    });
    expect(preview.counts).toEqual({
      tickets: 0,
      messages: 0,
      attachments: 0,
      originals: 0,
      translations: 0,
      issueLinks: 0,
      portalRecords: 0,
      runs: 0,
      jobs: 0,
      ingress: 0,
    });
    expect(preview.tickets).toEqual([]);
    await eraseRequester(canErase, projectId, {
      email: "nobody@example.test",
      expected: preview.counts,
    });
    expect(await countOf(tickets, eq(tickets.id, keep.ticketId))).toBe(1);
  });
  it("stays within its project: the same address in another project keeps its tickets", async () => {
    await clear();
    const mine = await arrive("kim@example.test", "Here");
    const [theirs] = await db()
      .insert(tickets)
      .values({
        projectId: otherProject,
        subject: "There",
        requesterEmail: "kim@example.test",
        requesterName: "Kim",
        language: "en",
      })
      .returning({ id: tickets.id });
    const preview = await previewRequesterErasure(canErase, projectId, {
      email: "kim@example.test",
    });
    expect(preview.counts.tickets).toBe(1);
    await eraseRequester(canErase, projectId, {
      email: "kim@example.test",
      expected: preview.counts,
    });
    expect(await countOf(tickets, eq(tickets.id, mine.ticketId))).toBe(0);
    expect(await countOf(tickets, eq(tickets.id, theirs?.id ?? ""))).toBe(1);
    await db().delete(tickets).where(eq(tickets.projectId, otherProject));
  });
});
