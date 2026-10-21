import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  jobs,
  memberships,
  notificationPreferences,
  notifications,
  projects,
  tickets,
  user,
} from "../src/server/db/schema";
import { emitEvent } from "../src/server/webhooks";
import { listMentionable, reply } from "../src/server/operations";
import {
  getPreferences,
  listNotifications,
  markRead,
  pruneNotifications,
  setPreferences,
} from "../src/server/notifications";
import { configOf } from "../src/server/configuration";
import {
  modesOf,
  notificationKinds,
  preferenceInput,
  ruleDefaults,
  ruleKeys,
  rulesOf,
} from "../src/domain/notifications";
import type { Action, Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectId = randomUUID();
const otherProject = randomUUID();
const worker = `notify-worker-${run}`;
const second = `notify-second-${run}`;
const reader = `notify-reader-${run}`;
const outsider = `notify-outsider-${run}`;
const people = [worker, second, reader, outsider];
const replying: Action[] = ["project.read", "ticket.read", "ticket.reply"];
const principal = (id: string, held: Action[] = replying): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: held }],
});
const ticket = async (assignee: string | null = null, project = projectId) => {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject: `Subject ${randomUUID().slice(0, 6)}`,
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      assigneeUserId: assignee,
    })
    .returning();
  if (!row) throw new Error("no ticket");
  return row;
};
const emit = (
  type: Parameters<typeof emitEvent>[2],
  data: Record<string, unknown>,
  project = projectId,
) => db().transaction((tx) => emitEvent(tx, project, type, data));
const rulesSet = (rules: Record<string, string>) =>
  db()
    .update(projects)
    .set({ settings: sql`${projects.settings} || ${JSON.stringify(rules)}::jsonb` })
    .where(eq(projects.id, projectId));
const received = async (userId: string) =>
  (await db().select().from(notifications).where(eq(notifications.userId, userId))).map(
    (row) => row.kind,
  );
const reset = async () => {
  await db().delete(notifications).where(inArray(notifications.userId, people));
  await db().delete(notificationPreferences).where(inArray(notificationPreferences.userId, people));
  await db()
    .update(projects)
    .set({ settings: {} })
    .where(inArray(projects.id, [projectId, otherProject]));
};
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Notify", slug: `notify-${run}` },
      { id: otherProject, name: "Notify other", slug: `notify-other-${run}` },
    ]);
  await db()
    .insert(user)
    .values(
      people.map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true })),
    );
  await db()
    .insert(memberships)
    .values([
      { userId: worker, projectId, actions: replying },
      { userId: second, projectId, actions: replying },
      { userId: reader, projectId, actions: ["project.read", "ticket.read"] },
    ]);
}, 60_000);
afterAll(async () => {
  await db().delete(audit).where(inArray(audit.actorId, people));
  await db()
    .delete(audit)
    .where(inArray(audit.projectId, [projectId, otherProject]));
  await db()
    .delete(jobs)
    .where(inArray(jobs.projectId, [projectId, otherProject]));
  await db()
    .delete(tickets)
    .where(inArray(tickets.projectId, [projectId, otherProject]));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProject]));
  await db().delete(user).where(inArray(user.id, people));
  await sqlClient().end();
});
describe("the rules of a project", () => {
  it("read as the defaults when nothing valid is stored, and keep a mode only where the kind allows it", () => {
    expect(rulesOf({})).toEqual({
      notifyNewTicket: "off",
      notifyAssignment: "assignee",
      notifyMention: "assignee",
      notifyOverdue: "assignee",
      notifyDraft: "assignee",
    });
    // A new ticket has no assignee; the mode that does not fit the kind and a stranger fall back.
    expect(rulesOf({ notifyNewTicket: "assignee", notifyOverdue: "everybody" })).toMatchObject({
      notifyNewTicket: "off",
      notifyOverdue: "assignee",
    });
    expect(rulesOf({ notifyOverdue: "members", notifyNewTicket: "members" })).toMatchObject({
      notifyOverdue: "members",
      notifyNewTicket: "members",
    });
    for (const kind of notificationKinds) expect(modesOf[kind]).toContain(ruleDefaults[kind]);
    expect(Object.keys(ruleKeys)).toEqual([...notificationKinds]);
  });
  it("are part of the configuration of the project", () => {
    const config = configOf({
      name: "P",
      color: "#336699",
      defaultLanguage: "en",
      settings: { notifyDraft: "members" },
    });
    expect(config).toMatchObject({ notifyDraft: "members", notifyAssignment: "assignee" });
  });
});
describe("the events that tell operators", () => {
  it("tells the assigned person of an assignment, and not the one who assigned or a person without rights", async () => {
    await reset();
    const row = await ticket(worker);
    const data = (assignee: string | null, actor: string) => ({
      ticketId: row.id,
      number: row.number,
      assigneeUserId: assignee,
      assigneeAgentId: null,
      actorId: actor,
    });
    await emit("ticket.assigned", data(worker, second));
    expect(await received(worker)).toEqual(["assignment"]);
    // Taking a ticket oneself is not news; an assignment to nobody tells nobody; a person who may not read does not hear.
    await emit("ticket.assigned", data(second, second));
    await emit("ticket.assigned", data(null, worker));
    await emit("ticket.assigned", data(outsider, worker));
    expect(await received(second)).toEqual([]);
    expect(await received(outsider)).toEqual([]);
    // The rule off tells nobody.
    await rulesSet({ notifyAssignment: "off" });
    await emit("ticket.assigned", data(worker, second));
    expect(await received(worker)).toEqual(["assignment"]);
  });
  it("tells everybody who may reply of a new ticket when the project says so, and nobody otherwise", async () => {
    await reset();
    const row = await ticket();
    const data = { ticketId: row.id, number: row.number, subject: row.subject, language: "en" };
    await emit("ticket.created", data);
    expect(await received(worker)).toEqual([]);
    await rulesSet({ notifyNewTicket: "members" });
    await emit("ticket.created", data);
    expect(await received(worker)).toEqual(["new_ticket"]);
    expect(await received(second)).toEqual(["new_ticket"]);
    // Somebody who only reads, a person of no project and a project that did not switch it on are left out.
    expect(await received(reader)).toEqual([]);
    expect(await received(outsider)).toEqual([]);
    const elsewhere = await ticket(null, otherProject);
    await emit(
      "ticket.created",
      { ticketId: elsewhere.id, number: elsewhere.number },
      otherProject,
    );
    expect(await received(worker)).toEqual(["new_ticket"]);
  });
  it("tells the assignee of an overdue ticket or a draft, and everybody who may reply when nobody is assigned", async () => {
    await reset();
    const assigned = await ticket(worker);
    const free = await ticket();
    await emit("ticket.overdue", { ticketId: assigned.id, number: assigned.number });
    expect(await received(worker)).toEqual(["overdue"]);
    expect(await received(second)).toEqual([]);
    await emit("ticket.overdue", { ticketId: free.id, number: free.number });
    expect(await received(second)).toEqual(["overdue"]);
    expect(await received(worker)).toEqual(["overdue", "overdue"]);
    await emit("draft.created", { ticketId: assigned.id, number: assigned.number, agentId: "x" });
    expect(await received(worker)).toContain("draft");
    expect(await received(second)).not.toContain("draft");
    // "members" reaches everybody who may reply, whatever the assignment.
    await rulesSet({ notifyOverdue: "members" });
    await emit("ticket.overdue", { ticketId: assigned.id, number: assigned.number });
    expect(await received(second)).toEqual(["overdue", "overdue"]);
    // An assignee who may no longer reply is not the one to tell; the people who may reply are.
    await db()
      .delete(memberships)
      .where(and(eq(memberships.userId, worker), eq(memberships.projectId, projectId)));
    await rulesSet({ notifyOverdue: "assignee" });
    await reset();
    await emit("ticket.overdue", { ticketId: assigned.id, number: assigned.number });
    expect(await received(second)).toEqual(["overdue"]);
    await db().insert(memberships).values({ userId: worker, projectId, actions: replying });
  });
  it("writes nothing when the transaction of the event is rolled back", async () => {
    await reset();
    const row = await ticket(worker);
    await expect(
      db().transaction(async (tx) => {
        await emitEvent(tx, projectId, "ticket.overdue", { ticketId: row.id });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await received(worker)).toEqual([]);
  });
  it("leaves a person out of a kind that they switched off in the desk, and tells them of the others", async () => {
    await reset();
    const row = await ticket(worker);
    await setPreferences(principal(worker), {
      preferences: [{ kind: "overdue", desk: false, mail: true }],
    });
    await emit("ticket.overdue", { ticketId: row.id, number: row.number });
    await emit("draft.created", { ticketId: row.id, number: row.number });
    expect(await received(worker)).toEqual(["draft"]);
  });
});
describe("the preferences of a person", () => {
  it("are on in both channels until the person chooses, and are saved by kind with an entry of the audit", async () => {
    await reset();
    await db().delete(audit).where(eq(audit.actorId, worker));
    const start = await getPreferences(principal(worker));
    expect(start.preferences.map((entry) => entry.kind)).toEqual([...notificationKinds]);
    expect(start.preferences.every((entry) => entry.desk && entry.mail)).toBe(true);
    const saved = await setPreferences(principal(worker), {
      preferences: [
        { kind: "mention", desk: true, mail: false },
        { kind: "overdue", desk: false, mail: false },
      ],
    });
    expect(saved.preferences.find((entry) => entry.kind === "mention")).toEqual({
      kind: "mention",
      desk: true,
      mail: false,
    });
    expect(saved.preferences.find((entry) => entry.kind === "draft")).toMatchObject({ desk: true });
    // The same kind again replaces the earlier choice; another person is not touched.
    await setPreferences(principal(worker), {
      preferences: [{ kind: "mention", desk: false, mail: true }],
    });
    expect((await getPreferences(principal(worker))).preferences).toContainEqual({
      kind: "mention",
      desk: false,
      mail: true,
    });
    expect((await getPreferences(principal(second))).preferences.every((entry) => entry.desk)).toBe(
      true,
    );
    const entries = (await db().select().from(audit).where(eq(audit.actorId, worker))).filter(
      (entry) => entry.action === "operator.notification_preferences",
    );
    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries[0]?.detail)).not.toContain("mail");
  });
  it("refuse a kind twice, an unknown kind, an empty list and more than a person of the kind", async () => {
    const duplicate = {
      preferences: [
        { kind: "mention", desk: true, mail: true },
        { kind: "mention", desk: false, mail: true },
      ],
    };
    expect(preferenceInput.safeParse(duplicate).success).toBe(false);
    expect(preferenceInput.safeParse({ preferences: [] }).success).toBe(false);
    expect(
      preferenceInput.safeParse({ preferences: [{ kind: "spam", desk: true, mail: true }] })
        .success,
    ).toBe(false);
    expect(
      preferenceInput.safeParse({ preferences: [{ kind: "draft", desk: true }] }).success,
    ).toBe(false);
    await expect(setPreferences(principal(worker), duplicate)).rejects.toThrow();
  });
  it("are for people and not for agents or people who are switched off", async () => {
    for (const bad of [
      { ...principal(worker), kind: "agent" as const },
      { ...principal(worker), active: false },
    ]) {
      await expect(getPreferences(bad)).rejects.toMatchObject({ code: "forbidden" });
      await expect(listNotifications(bad, {})).rejects.toMatchObject({ code: "forbidden" });
      await expect(markRead(bad, {})).rejects.toMatchObject({ code: "forbidden" });
    }
  });
});
describe("the list of a person", () => {
  const tell = async (count: number, assignee: string) => {
    const made = [];
    for (let index = 0; index < count; index += 1) {
      const row = await ticket(assignee);
      await emit("ticket.overdue", { ticketId: row.id, number: row.number });
      made.push(row);
    }
    return made;
  };
  it("is newest first with the number and the subject of the ticket, counts the unread ones and pages", async () => {
    await reset();
    const made = await tell(5, worker);
    const first = await listNotifications(principal(worker), { limit: "2" });
    expect(first.unread).toBe(5);
    expect(first.notifications).toHaveLength(2);
    expect(first.notifications[0]).toMatchObject({
      kind: "overdue",
      ticketId: made[4]?.id,
      ticketNumber: made[4]?.number,
      subject: made[4]?.subject,
      projectName: "Notify",
      readAt: null,
    });
    expect(first.next).not.toBeNull();
    const middle = await listNotifications(principal(worker), { limit: "2", before: first.next });
    const rest = await listNotifications(principal(worker), { limit: "10", before: middle.next });
    const ids = [...first.notifications, ...middle.notifications, ...rest.notifications].map(
      (entry) => entry.ticketId,
    );
    expect(ids).toEqual(made.map((row) => row.id).reverse());
    expect(rest.next).toBeNull();
    // Nothing of another person.
    expect((await listNotifications(principal(second), {})).notifications).toEqual([]);
    await expect(
      listNotifications(principal(worker), { before: "not-a-cursor" }),
    ).rejects.toThrow();
  });
  it("marks one, several or all as read, only its own, and filters the unread ones", async () => {
    await reset();
    await tell(3, worker);
    await tell(1, second);
    const all = (await listNotifications(principal(worker), {})).notifications;
    const [one, two] = all;
    expect(await markRead(principal(worker), { ids: [one?.id ?? ""] })).toEqual({ read: 1 });
    expect(await markRead(principal(worker), { ids: [one?.id ?? ""] })).toEqual({ read: 0 });
    const foreign = (await listNotifications(principal(second), {})).notifications[0];
    expect(await markRead(principal(worker), { ids: [foreign?.id ?? ""] })).toEqual({ read: 0 });
    expect((await listNotifications(principal(second), {})).unread).toBe(1);
    const unread = await listNotifications(principal(worker), { unread: "true" });
    expect(unread.notifications.map((entry) => entry.id)).not.toContain(one?.id);
    expect(unread.unread).toBe(2);
    expect(await markRead(principal(worker), {})).toEqual({ read: 2 });
    expect((await listNotifications(principal(worker), {})).unread).toBe(0);
    expect((await listNotifications(principal(worker), { unread: "true" })).notifications).toEqual(
      [],
    );
    expect(two?.readAt).toBeNull();
    await expect(markRead(principal(worker), { ids: [] })).rejects.toThrow();
  });
  it("leaves out what a person may no longer read", async () => {
    await reset();
    await tell(2, worker);
    expect((await listNotifications(principal(worker), {})).notifications).toHaveLength(2);
    await db()
      .update(memberships)
      .set({ actions: ["project.read"] })
      .where(and(eq(memberships.userId, worker), eq(memberships.projectId, projectId)));
    expect(await listNotifications(principal(worker), {})).toEqual({
      notifications: [],
      unread: 0,
      next: null,
    });
    await db()
      .update(memberships)
      .set({ actions: replying })
      .where(and(eq(memberships.userId, worker), eq(memberships.projectId, projectId)));
  });
  it("shows the notifications of the projects that a person still reads, and only those", async () => {
    await reset();
    await db()
      .insert(memberships)
      .values({ userId: worker, projectId: otherProject, actions: replying });
    await tell(1, worker);
    const elsewhere = await ticket(worker, otherProject);
    await emit(
      "ticket.overdue",
      { ticketId: elsewhere.id, number: elsewhere.number },
      otherProject,
    );
    const both = await listNotifications(principal(worker), {});
    expect(both.unread).toBe(2);
    expect(both.notifications.map((entry) => entry.projectName).sort()).toEqual([
      "Notify",
      "Notify other",
    ]);
    await db()
      .update(memberships)
      .set({ actions: ["project.read"] })
      .where(and(eq(memberships.userId, worker), eq(memberships.projectId, otherProject)));
    const one = await listNotifications(principal(worker), {});
    expect(one.unread).toBe(1);
    expect(one.notifications.map((entry) => entry.projectName)).toEqual(["Notify"]);
    await db().delete(memberships).where(eq(memberships.projectId, otherProject));
  });
  it("goes with the ticket when it is deleted", async () => {
    await reset();
    const [row] = await tell(1, worker);
    await db()
      .delete(tickets)
      .where(eq(tickets.id, row?.id ?? ""));
    expect(await received(worker)).toEqual([]);
  });
});
describe("the notifications that are kept", () => {
  it("are removed after ninety days, read or not, and not before", async () => {
    await reset();
    const row = await ticket(worker);
    await emit("ticket.overdue", { ticketId: row.id });
    await emit("ticket.overdue", { ticketId: row.id });
    const [old, fresh] = await db()
      .select()
      .from(notifications)
      .where(eq(notifications.userId, worker));
    await db()
      .update(notifications)
      .set({ createdAt: sql`now() - interval '91 days'` })
      .where(eq(notifications.id, old?.id ?? ""));
    await db()
      .update(notifications)
      .set({ createdAt: sql`now() - interval '89 days'` })
      .where(eq(notifications.id, fresh?.id ?? ""));
    expect(await pruneNotifications()).toBeGreaterThanOrEqual(1);
    const left = await db().select().from(notifications).where(eq(notifications.userId, worker));
    expect(left.map((entry) => entry.id)).toEqual([fresh?.id]);
  });
});
describe("the mention of a person in a note", () => {
  const noting: Action[] = ["project.read", "ticket.read", "ticket.note"];
  const writer = (held: Action[] = noting): Principal => ({
    id: second,
    kind: "human",
    active: true,
    owner: false,
    grants: [{ projectId, actions: held }],
  });
  const note = (
    row: { id: string; revision: number; language: string },
    mentions: string[],
    extra: Record<string, unknown> = {},
  ) =>
    reply(writer(), row.id, {
      markdown: "Please look at this",
      internal: true,
      expectedRevision: row.revision,
      idempotencyKey: randomUUID(),
      language: row.language,
      mentions,
      ...extra,
    });
  it("tells the named people who may read the ticket, once, and not the author or a stranger", async () => {
    await reset();
    const row = await ticket();
    await note(row, [worker, worker, second, reader, outsider, "nobody-here"]);
    expect(await received(worker)).toEqual(["mention"]);
    expect(await received(reader)).toEqual(["mention"]);
    expect(await received(second)).toEqual([]);
    expect(await received(outsider)).toEqual([]);
    const shown = (await listNotifications(principal(worker), {})).notifications[0];
    expect(shown).toMatchObject({ kind: "mention", ticketId: row.id, subject: row.subject });
  });
  it("tells nobody when the project switched the rule off, or the note names nobody", async () => {
    await reset();
    const row = await ticket();
    await note(row, []);
    expect(await received(worker)).toEqual([]);
    await rulesSet({ notifyMention: "off" });
    await note({ ...row, revision: row.revision + 1 }, [worker]);
    expect(await received(worker)).toEqual([]);
  });
  it("is refused for a reply to the customer and for more than ten people, and writes nothing when the note fails", async () => {
    await reset();
    // The project can send, so that the reply would otherwise be accepted.
    await rulesSet({ outboundConnectionId: randomUUID() });
    const row = await ticket();
    await expect(
      reply(writer([...noting, "ticket.reply"]), row.id, {
        markdown: "Answer",
        internal: false,
        expectedRevision: row.revision,
        idempotencyKey: randomUUID(),
        language: row.language,
        mentions: [worker],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      note(
        row,
        Array.from({ length: 11 }, (_, index) => `p${String(index)}`),
      ),
    ).rejects.toThrow();
    // A stale revision is a conflict, and nobody is told.
    await expect(note({ ...row, revision: row.revision + 5 }, [worker])).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await received(worker)).toEqual([]);
  });
  it("is told once when the same request is repeated", async () => {
    await reset();
    const row = await ticket();
    const key = randomUUID();
    const again = () => note(row, [worker], { idempotencyKey: key });
    expect(await again()).toMatchObject({ duplicate: false });
    expect(await again()).toMatchObject({ duplicate: true });
    expect(await received(worker)).toEqual(["mention"]);
  });
  it("lists the people who may read the ticket for a person who may write a note, and for nobody else", async () => {
    const row = await ticket();
    const list = await listMentionable(writer(), row.id);
    expect(list.users.map((person) => person.id).sort()).toEqual([reader, second, worker].sort());
    await expect(
      listMentionable(writer(["project.read", "ticket.read"]), row.id),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(listMentionable({ ...writer(), kind: "agent" }, row.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      listMentionable(
        { ...writer(), grants: [{ projectId: otherProject, actions: noting }] },
        row.id,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
