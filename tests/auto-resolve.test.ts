import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  connections,
  jobs,
  messages,
  projects,
  tickets,
  workspaceSettings,
} from "../src/server/db/schema";
import { scanAutoResolve } from "../src/server/auto-resolve";
import { controlsKey, useControlsKey } from "../src/server/controls";
import { configDocument } from "../src/domain/configuration";
import { autoResolveOf } from "../src/domain/reply-policy";
import { reminderText } from "../src/domain/acknowledgement";
import { runNext } from "../src/worker/jobs";
import { startFakeSmtp, type FakeSmtp } from "./support/smtp";
const day = 86_400_000;
const projectId = randomUUID();
const otherProject = randomUUID();
const archivedProject = randomUUID();
const connectionId = randomUUID();
let smtp: FakeSmtp;
useControlsKey(`controls-auto-${randomUUID()}`);
const policy = { autoResolveDays: 14, autoResolveReminderDays: 3 };
const setSettings = (settings: Record<string, unknown>, project = projectId) =>
  db().update(projects).set({ settings }).where(eq(projects.id, project));
const base = (extra: Record<string, unknown> = {}) => ({
  outboundConnectionId: connectionId,
  ...policy,
  ...extra,
});
// A ticket that has waited for `days` days (and `extraMs`) at the moment `at`.
async function waiting(
  days: number,
  at: Date,
  fields: Partial<typeof tickets.$inferInsert> = {},
  project = projectId,
) {
  const [ticket] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject: "Waiting",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      status: "waiting",
      waitingSince: new Date(at.getTime() - days * day),
      ...fields,
    })
    .returning();
  if (!ticket) throw new Error("ticket");
  return ticket;
}
const row = async (id: string) => (await db().select().from(tickets).where(eq(tickets.id, id)))[0];
const notes = (id: string, kind: string) =>
  db()
    .select()
    .from(messages)
    .where(eq(messages.ticketId, id))
    .then((all) => all.filter((message) => (message.source as { kind?: string }).kind === kind));
beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEV_BOOTSTRAP", "true");
  await migrate(db(), { migrationsFolder: "drizzle" });
  smtp = await startFakeSmtp();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Auto Resolve", slug: `auto-${projectId}`, settings: base() },
      { id: otherProject, name: "No Policy", slug: `auto-${otherProject}` },
      {
        id: archivedProject,
        name: "Archived",
        slug: `auto-${archivedProject}`,
        settings: base(),
        archivedAt: new Date(),
      },
    ]);
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
});
afterEach(async () => {
  await setSettings(base());
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  smtp.messages.length = 0;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await smtp.close();
  const ids = [projectId, otherProject, archivedProject];
  await db().delete(workspaceSettings).where(eq(workspaceSettings.key, controlsKey()));
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("the reminder before an automatic resolve", () => {
  it("is queued once the wait has lasted the days minus the reminder days, and not a moment before", async () => {
    const at = new Date();
    const early = await waiting(11, new Date(at.getTime() + 1));
    const result = await scanAutoResolve(at);
    expect(result).toMatchObject({ reminded: 0 });
    expect((await row(early.id))?.autoRemindedFor).toBeNull();
    const edge = await waiting(11, at);
    expect(await scanAutoResolve(at)).toMatchObject({ reminded: 1 });
    expect((await row(edge.id))?.autoRemindedFor?.getTime()).toBe(edge.waitingSince?.getTime());
  });
  it("is one mail with the number and the days, from the system, and is written to the audit", async () => {
    const at = new Date();
    const ticket = await waiting(12, at);
    await scanAutoResolve(at);
    const [reminder] = await notes(ticket.id, "auto_resolve_reminder");
    expect(reminder).toMatchObject({
      authorType: "system",
      internal: false,
      deliveryState: "queued",
      markdown: reminderText("en", ticket.number, 14),
    });
    expect(reminder?.markdown).toContain(`#${String(ticket.number)}`);
    expect(reminder?.markdown).toContain("14 days");
    const queued = (await db().select().from(jobs).where(eq(jobs.projectId, projectId))).filter(
      (job) => job.payload.messageId === reminder?.id,
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: "mail.send",
      payload: { actorKind: "system", resolve: false },
    });
    const entries = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.targetId, ticket.id), eq(audit.action, "ticket.auto_resolve_reminder")));
    expect(entries).toHaveLength(1);
  });
  it("is sent once for each wait, and again for a new wait of the same ticket", async () => {
    const at = new Date();
    const ticket = await waiting(12, at);
    await scanAutoResolve(at);
    await scanAutoResolve(new Date(at.getTime() + 60_000));
    expect(await notes(ticket.id, "auto_resolve_reminder")).toHaveLength(1);
    // The customer answered, the team answered again: a new wait with a new start.
    await db()
      .update(tickets)
      .set({ waitingSince: new Date(at.getTime() - 12 * day + 1000) })
      .where(eq(tickets.id, ticket.id));
    await scanAutoResolve(at);
    expect(await notes(ticket.id, "auto_resolve_reminder")).toHaveLength(2);
  });
  it("is not queued without a reminder time, without an outgoing connection or while mail is paused, but the wait counts as reminded", async () => {
    const at = new Date();
    await setSettings(base({ autoResolveReminderDays: null }));
    const none = await waiting(12, at);
    expect(await scanAutoResolve(at)).toMatchObject({ reminded: 0 });
    expect(await notes(none.id, "auto_resolve_reminder")).toHaveLength(0);
    for (const settings of [base({ outboundConnectionId: null }), base({ pauseOutgoing: true })]) {
      await setSettings(settings);
      const ticket = await waiting(12, at);
      await scanAutoResolve(at);
      expect(await notes(ticket.id, "auto_resolve_reminder")).toHaveLength(0);
      expect((await row(ticket.id))?.autoRemindedFor).not.toBeNull();
    }
  });
});
describe("the automatic resolve", () => {
  it("resolves a waiting ticket once the wait has lasted the days, and not a moment before", async () => {
    const at = new Date();
    const early = await waiting(14, new Date(at.getTime() + 1));
    expect(await scanAutoResolve(at)).toMatchObject({ resolved: 0 });
    expect((await row(early.id))?.status).toBe("waiting");
    const edge = await waiting(14, at);
    expect(await scanAutoResolve(at)).toMatchObject({ resolved: 1 });
    const after = await row(edge.id);
    expect(after).toMatchObject({ status: "resolved", waitingSince: null, pendingSince: null });
    expect(after?.resolvedAt?.getTime()).toBe(at.getTime());
    expect(after?.revision).toBe(edge.revision + 1);
  });
  it("leaves a trace for the team in the conversation and in the audit, and does nothing a second time", async () => {
    const at = new Date();
    const ticket = await waiting(20, at);
    await scanAutoResolve(at);
    const [trace] = await notes(ticket.id, "auto_resolve");
    expect(trace).toMatchObject({
      internal: true,
      authorType: "system",
      deliveryState: "internal",
    });
    expect(trace?.markdown).toContain("14 days");
    expect(
      await db()
        .select()
        .from(audit)
        .where(and(eq(audit.targetId, ticket.id), eq(audit.action, "ticket.auto_resolve"))),
    ).toHaveLength(1);
    expect(await scanAutoResolve(at)).toMatchObject({ resolved: 0 });
    expect(await notes(ticket.id, "auto_resolve")).toHaveLength(1);
  });
  it("leaves alone a ticket that is open, resolved or in junk, one of a project without the policy and one of an archived project", async () => {
    const at = new Date();
    const kept = [
      await waiting(30, at, { status: "open" }),
      await waiting(30, at, { status: "resolved", resolvedAt: new Date(at.getTime() - 5 * day) }),
      await waiting(30, at, { junkAt: new Date(), junkReason: "operator" }),
      await waiting(30, at, {}, otherProject),
      await waiting(30, at, {}, archivedProject),
      await waiting(30, at, { waitingSince: null }),
    ];
    const result = await scanAutoResolve(at);
    expect(result).toMatchObject({ resolved: 0, reminded: 0 });
    for (const ticket of kept) expect((await row(ticket.id))?.status).toBe(ticket.status);
  });
  it("is the days of the project, not a fixed number", async () => {
    const at = new Date();
    await setSettings(base({ autoResolveDays: 5, autoResolveReminderDays: null }));
    const ticket = await waiting(6, at);
    await scanAutoResolve(at);
    expect((await row(ticket.id))?.status).toBe("resolved");
  });
  it("resolves without a reminder when the project sets none, and when the reminder could not be sent", async () => {
    const at = new Date();
    await setSettings(base({ outboundConnectionId: null }));
    const ticket = await waiting(15, at);
    expect(await scanAutoResolve(at)).toMatchObject({ resolved: 1 });
    expect((await row(ticket.id))?.status).toBe("resolved");
  });
});
describe("two scans at the same time", () => {
  it("send one reminder and make one resolve for each wait", async () => {
    const at = new Date();
    const reminded = await waiting(12, at);
    const due = await waiting(20, at);
    await Promise.all([scanAutoResolve(at), scanAutoResolve(at), scanAutoResolve(at)]);
    expect(await notes(reminded.id, "auto_resolve_reminder")).toHaveLength(1);
    expect(await notes(due.id, "auto_resolve")).toHaveLength(1);
    expect((await row(due.id))?.status).toBe("resolved");
  });
});
describe("the policy in the configuration", () => {
  const document = {
    name: "X",
    color: "#5167ed",
    defaultLanguage: "en",
    acknowledgements: false,
    portalLinks: false,
    approvalPolicy: "review",
    outboundConnectionId: null,
    pauseOutgoing: false,
    warnHours: 4,
    overdueHours: 24,
    reopenMode: "reopen",
    reopenDays: 30,
    autoResolveDays: null,
    autoResolveReminderDays: null,
    junkSensitivity: "standard",
    businessDays: null,
    businessStart: "09:00",
    businessEnd: "17:00",
    businessTimeZone: null,
    holidays: "",
  };
  it("takes days from 1 to 365 or none, and a reminder only with days and before them", () => {
    const ok = (change: Record<string, unknown>) =>
      configDocument.safeParse({ ...document, ...change }).success;
    expect(ok({})).toBe(true);
    expect(ok({ autoResolveDays: 14 })).toBe(true);
    expect(ok({ autoResolveDays: 14, autoResolveReminderDays: 13 })).toBe(true);
    for (const bad of [
      { autoResolveDays: 0 },
      { autoResolveDays: 366 },
      { autoResolveDays: 1.5 },
      { autoResolveDays: 14, autoResolveReminderDays: 14 },
      { autoResolveDays: 14, autoResolveReminderDays: 20 },
      { autoResolveDays: null, autoResolveReminderDays: 3 },
      { autoResolveDays: 14, autoResolveReminderDays: 0 },
    ])
      expect(ok(bad), JSON.stringify(bad)).toBe(false);
  });
  it("reads values that are not valid from the settings as no policy", () => {
    expect(autoResolveOf({})).toEqual({ days: null, reminderDays: null });
    expect(autoResolveOf({ autoResolveDays: "14", autoResolveReminderDays: 3 })).toEqual({
      days: null,
      reminderDays: null,
    });
    expect(autoResolveOf({ autoResolveDays: 14, autoResolveReminderDays: 14 })).toEqual({
      days: 14,
      reminderDays: null,
    });
    expect(autoResolveOf({ autoResolveDays: 14, autoResolveReminderDays: 3 })).toEqual({
      days: 14,
      reminderDays: 3,
    });
  });
});
describe("the mail of the reminder", () => {
  it("is sent by the worker to the requester, as automatic mail that does not change the ticket", async () => {
    const at = new Date();
    const ticket = await waiting(12, at);
    await scanAutoResolve(at);
    expect(await runNext({ projectId })).toBe(true);
    const parsed = await simpleParser(Buffer.from(smtp.messages.at(-1) ?? ""));
    expect(parsed.to).toMatchObject({ value: [{ address: "kim@example.test" }] });
    expect(parsed.text).toContain("14 days");
    const after = await row(ticket.id);
    expect(after).toMatchObject({ status: "waiting" });
    expect(after?.waitingSince?.getTime()).toBe(ticket.waitingSince?.getTime());
  });
  it("is not sent when the ticket does not wait any more, and the job names why", async () => {
    const at = new Date();
    const ticket = await waiting(12, at);
    await scanAutoResolve(at);
    await db().update(tickets).set({ status: "open" }).where(eq(tickets.id, ticket.id));
    await runNext({ projectId });
    expect(smtp.messages).toHaveLength(0);
    const [job] = (await db().select().from(jobs).where(eq(jobs.projectId, projectId))).filter(
      (entry) => entry.type === "mail.send",
    );
    expect(job).toMatchObject({ status: "review", lastErrorCode: "auto_resolve_not_enabled" });
  });
  it("is not sent when the project has turned the reminder off in the meantime", async () => {
    const at = new Date();
    await waiting(12, at);
    await scanAutoResolve(at);
    await setSettings(base({ autoResolveReminderDays: null }));
    await runNext({ projectId });
    expect(smtp.messages).toHaveLength(0);
  });
});
