import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  keepDays,
  notificationKinds,
  notificationQuery,
  preferenceDefaults,
  preferenceInput,
  readInput,
  ruleKeys,
  rulesOf,
  type NotificationKind,
} from "../domain/notifications";
import type { Principal } from "../domain/permissions";
import type { WebhookEvent } from "../domain/webhooks";
import { db } from "./db";
import {
  audit,
  connections,
  jobs,
  notificationPreferences,
  notifications,
  projects,
  tickets,
} from "./db/schema";
import { DomainError } from "./errors";
import { grantsOf, peopleWith } from "./grants";
type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
// The events of a project that tell operators about something. The mention of a person in a note is not an event of
// the webhooks and calls `notifyMentioned` itself.
const kindOfEvent: Partial<Record<WebhookEvent, NotificationKind>> = {
  "ticket.created": "new_ticket",
  "ticket.assigned": "assignment",
  "ticket.overdue": "overdue",
  "draft.created": "draft",
};
// The job that sends the mail of a notification (see `worker/notification-mail.ts`).
export const mailJob = "notify.mail";
// Whether the project can send mail now: an outgoing connection that is chosen, ready, and not paused.
async function canMail(tx: Tx, settings: Record<string, unknown>): Promise<boolean> {
  if (settings.pauseOutgoing === true || typeof settings.outboundConnectionId !== "string")
    return false;
  const [connection] = await tx
    .select({ status: connections.status })
    .from(connections)
    .where(
      and(eq(connections.id, settings.outboundConnectionId), eq(connections.direction, "outbound")),
    );
  return connection?.status === "ready";
}
export interface Notified {
  userId: string;
  kind: NotificationKind;
  ticketId: string | null;
}
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
// Whoever may answer in the project: they are the ones that a ticket without a person waits for.
const members = async (tx: Tx, project: string) =>
  (await peopleWith(project, "ticket.reply", tx)).map((person) => person.id);
// The people that a rule reaches for an event, in the transaction that made the event happen. Recipients are
// people who hold the right to reply now; the person who did the thing is not told about it.
async function recipientsOf(
  tx: Tx,
  project: string,
  kind: NotificationKind,
  mode: "assignee" | "members",
  data: Record<string, unknown>,
): Promise<string[]> {
  if (kind === "new_ticket") return members(tx, project);
  if (kind === "mention") {
    // The people that a note names, as far as they may read the ticket; whoever wrote the note is not told of it.
    const named = Array.isArray(data.mentionedUserIds)
      ? data.mentionedUserIds.filter((entry): entry is string => typeof entry === "string")
      : [];
    const readers = new Set(
      (await peopleWith(project, "ticket.read", tx)).map((person) => person.id),
    );
    return named.filter((userId) => userId !== text(data.actorId) && readers.has(userId));
  }
  if (kind === "assignment") {
    const assignee = text(data.assigneeUserId);
    if (!assignee || assignee === text(data.actorId)) return [];
    const readers = await peopleWith(project, "ticket.read", tx);
    return readers.some((person) => person.id === assignee) ? [assignee] : [];
  }
  if (mode === "members") return members(tx, project);
  const ticketId = text(data.ticketId);
  const [ticket] = ticketId
    ? await tx
        .select({ assignee: tickets.assigneeUserId })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
    : [];
  if (!ticket?.assignee) return members(tx, project);
  const may = await members(tx, project);
  return may.includes(ticket.assignee) ? [ticket.assignee] : members(tx, project);
}
// Writes the notifications that the rules of the project call for. Called by `emitEvent`, inside the transaction of
// the event, so that a notification is neither lost nor written for a change that was rolled back.
export async function notifyOperators(
  tx: Tx,
  project: string,
  type: WebhookEvent,
  data: Record<string, unknown>,
): Promise<Notified[]> {
  const kind = kindOfEvent[type];
  if (!kind) return [];
  return notifyKind(tx, project, kind, data);
}
export async function notifyKind(
  tx: Tx,
  project: string,
  kind: NotificationKind,
  data: Record<string, unknown>,
): Promise<Notified[]> {
  const [row] = await tx
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, project));
  if (!row) return [];
  const mode = rulesOf(row.settings)[ruleKeys[kind]];
  if (mode === "off") return [];
  const people = [...new Set(await recipientsOf(tx, project, kind, mode, data))];
  if (people.length === 0) return [];
  const chosen = await tx
    .select()
    .from(notificationPreferences)
    .where(
      and(eq(notificationPreferences.kind, kind), inArray(notificationPreferences.userId, people)),
    );
  const prefer = new Map(chosen.map((entry) => [entry.userId, entry]));
  const ticketId = text(data.ticketId);
  const wanted = people.filter((userId) => prefer.get(userId)?.desk ?? preferenceDefaults.desk);
  if (wanted.length > 0)
    await tx
      .insert(notifications)
      .values(wanted.map((userId) => ({ userId, projectId: project, kind, ticketId })));
  // Mail goes to those who want it, when the project has an outgoing connection that is ready and does not pause it.
  const byMail =
    ticketId && (await canMail(tx, row.settings))
      ? people.filter((userId) => prefer.get(userId)?.mail ?? preferenceDefaults.mail)
      : [];
  if (byMail.length > 0 && ticketId)
    await tx.insert(jobs).values(
      byMail.map((userId) => ({
        projectId: project,
        type: mailJob,
        dedupKey: `notify-mail:${randomUUID()}`,
        payload: { userId, kind, ticketId },
      })),
    );
  return people.map((userId) => ({ userId, kind, ticketId }));
}
function human(principal: Principal): string {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  return principal.id;
}
// The projects in which a person may read tickets now; a notification of another project is not shown any more.
async function readableProjects(userId: string): Promise<string[]> {
  return (await grantsOf(userId))
    .filter((grant) => grant.actions.includes("ticket.read"))
    .map((grant) => grant.projectId);
}
const encode = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString("base64url");
function decode(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (!at || !id || Number.isNaN(Date.parse(at))) throw new DomainError("invalid_input", 400);
  return { at, id };
}
export async function listNotifications(principal: Principal, input: unknown) {
  const userId = human(principal);
  const query = notificationQuery.parse(input);
  const limit = query.limit ?? 30;
  const projectIds = await readableProjects(userId);
  if (projectIds.length === 0) return { notifications: [], unread: 0, next: null };
  const mine = and(eq(notifications.userId, userId), inArray(notifications.projectId, projectIds));
  const [counted] = await db()
    .select({ unread: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(mine, isNull(notifications.readAt)));
  const cursor = query.before ? decode(query.before) : null;
  const rows = await db()
    .select({
      id: notifications.id,
      kind: notifications.kind,
      projectId: notifications.projectId,
      projectName: projects.name,
      ticketId: notifications.ticketId,
      ticketNumber: tickets.number,
      subject: tickets.subject,
      createdAt: notifications.createdAt,
      at: sql<string>`${notifications.createdAt}::text`,
      readAt: notifications.readAt,
    })
    .from(notifications)
    .innerJoin(projects, eq(projects.id, notifications.projectId))
    .leftJoin(tickets, eq(tickets.id, notifications.ticketId))
    .where(
      and(
        mine,
        query.unread === "true" ? isNull(notifications.readAt) : undefined,
        cursor
          ? or(
              sql`${notifications.createdAt} < ${cursor.at}::timestamptz`,
              and(
                sql`${notifications.createdAt} = ${cursor.at}::timestamptz`,
                lt(notifications.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    notifications: page.map((row) => ({
      id: row.id,
      kind: notificationKinds.find((kind) => kind === row.kind) ?? "assignment",
      projectId: row.projectId,
      projectName: row.projectName,
      ticketId: row.ticketId,
      ticketNumber: row.ticketNumber,
      subject: row.subject,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    })),
    unread: counted?.unread ?? 0,
    next: rows.length > limit && last ? encode(last.at, last.id) : null,
  };
}
// Marks some notifications of the person as read, or all of them when none is named.
export async function markRead(principal: Principal, input: unknown) {
  const userId = human(principal);
  const { ids } = readInput.parse(input);
  const done = await db()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        ids ? inArray(notifications.id, ids) : undefined,
      ),
    )
    .returning({ id: notifications.id });
  return { read: done.length };
}
export async function getPreferences(principal: Principal) {
  const userId = human(principal);
  const chosen = await db()
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));
  const byKind = new Map(chosen.map((entry) => [entry.kind, entry]));
  return {
    preferences: notificationKinds.map((kind) => ({
      kind,
      desk: byKind.get(kind)?.desk ?? preferenceDefaults.desk,
      mail: byKind.get(kind)?.mail ?? preferenceDefaults.mail,
    })),
  };
}
export async function setPreferences(principal: Principal, input: unknown) {
  const userId = human(principal);
  const { preferences } = preferenceInput.parse(input);
  await db().transaction(async (tx) => {
    for (const entry of preferences)
      await tx
        .insert(notificationPreferences)
        .values({ userId, kind: entry.kind, desk: entry.desk, mail: entry.mail })
        .onConflictDoUpdate({
          target: [notificationPreferences.userId, notificationPreferences.kind],
          set: { desk: entry.desk, mail: entry.mail, updatedAt: new Date() },
        });
    await tx.insert(audit).values({
      actorId: userId,
      action: "operator.notification_preferences",
      targetId: userId,
      detail: { kinds: preferences.map((entry) => entry.kind) },
    });
  });
  return getPreferences(principal);
}
// Removes what is older than the days that a notification is kept, in the pass of the worker that also keeps the
// retention.
export async function pruneNotifications(): Promise<number> {
  const gone = await db()
    .delete(notifications)
    .where(sql`${notifications.createdAt} < now() - make_interval(days => ${keepDays})`)
    .returning({ id: notifications.id });
  return gone.length;
}
