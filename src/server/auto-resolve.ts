import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { reminderText } from "../domain/acknowledgement";
import { autoResolveOf } from "../domain/reply-policy";
import { db } from "./db";
import { audit, jobs, messages, projects, tickets } from "./db/schema";
import { workspaceControls } from "./controls";
import { activeTexts } from "./texts";
import { emitEvent } from "./webhooks";
// A ticket that waits for the customer is resolved when the project says so: after `autoResolveDays` without an
// answer, with a reminder `autoResolveReminderDays` before that. The wait begins when the team's answer is sent
// (`waiting_since`). A reply of the customer reopens the ticket and ends the wait. Both steps happen once for each
// wait: the reminder is marked by the start of the wait that it was sent for. The worker looks about every five
// minutes; the steps are small, so a run that is cut off is finished by the next.
const day = 86_400_000;
const batch = 100;
type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
const waiting = and(
  eq(tickets.status, "waiting"),
  isNull(tickets.junkAt),
  isNull(projects.archivedAt),
  sql`${tickets.waitingSince} is not null`,
);
const intervalOf = (key: "autoResolveDays" | "autoResolveReminderDays") =>
  sql`(${projects.settings}->>${key})::int`;
export async function scanAutoResolve(now: Date = new Date()): Promise<{
  reminded: number;
  resolved: number;
}> {
  const controls = await workspaceControls();
  let reminded = 0;
  let resolved = 0;
  // The reminders: due when the wait has lasted `days - reminderDays`, and not sent for this wait yet.
  const due = await db()
    .select({ id: tickets.id })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(
      and(
        waiting,
        sql`${intervalOf("autoResolveReminderDays")} is not null`,
        sql`${intervalOf("autoResolveDays")} > ${intervalOf("autoResolveReminderDays")}`,
        sql`${tickets.waitingSince} + make_interval(days => ${intervalOf("autoResolveDays")} - ${intervalOf("autoResolveReminderDays")}) <= ${now.toISOString()}::timestamptz`,
        sql`${tickets.autoRemindedFor} is distinct from ${tickets.waitingSince}`,
      ),
    )
    .limit(batch);
  for (const row of due) if (await remind(row.id, now, controls.pauseOutgoing)) reminded += 1;
  // The resolves: due when the wait has lasted `days`.
  const over = await db()
    .select({ id: tickets.id })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(
      and(
        waiting,
        sql`${intervalOf("autoResolveDays")} is not null`,
        sql`${tickets.waitingSince} + make_interval(days => ${intervalOf("autoResolveDays")}) <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .limit(batch);
  for (const row of over) if (await resolve(row.id, now)) resolved += 1;
  return { reminded, resolved };
}
// The ticket again, locked and with its project, so that a reply or a change since the query is seen.
async function locked(tx: Tx, id: string) {
  const [row] = await tx
    .select({ ticket: tickets, project: projects })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(and(eq(tickets.id, id), waiting))
    .for("update", { of: tickets, skipLocked: true });
  return row;
}
async function remind(id: string, now: Date, paused: boolean): Promise<boolean> {
  return db().transaction(async (tx) => {
    const row = await locked(tx, id);
    if (!row?.ticket.waitingSince) return false;
    const policy = autoResolveOf(row.project.settings);
    const wait = row.ticket.waitingSince;
    if (
      policy.days === null ||
      policy.reminderDays === null ||
      wait.getTime() + (policy.days - policy.reminderDays) * day > now.getTime() ||
      row.ticket.autoRemindedFor?.getTime() === wait.getTime()
    )
      return false;
    // The wait is marked as reminded in every case: a project that cannot send, or has paused its mail, does not
    // get the mail later, when the wait is nearly over.
    await tx.update(tickets).set({ autoRemindedFor: wait }).where(eq(tickets.id, id));
    const connectionId = row.project.settings.outboundConnectionId;
    if (typeof connectionId !== "string" || row.project.settings.pauseOutgoing === true || paused)
      return false;
    const language = row.ticket.language;
    const [message] = await tx
      .insert(messages)
      .values({
        ticketId: id,
        authorType: "system",
        authorName: row.project.name,
        markdown: reminderText(
          language,
          row.ticket.number,
          policy.days,
          (await activeTexts(row.ticket.projectId, language)).autoResolveReminder,
        ),
        language,
        deliveryState: "queued",
        source: { kind: "auto_resolve_reminder" },
      })
      .returning({ id: messages.id });
    if (!message) throw new Error("reminder_creation_failed");
    await tx.insert(jobs).values({
      projectId: row.ticket.projectId,
      type: "mail.send",
      dedupKey: `auto-resolve-reminder:${id}:${wait.toISOString()}`,
      payload: {
        ticketId: id,
        messageId: message.id,
        connectionId,
        actorId: "system",
        actorKind: "system",
        expectedRevision: row.ticket.revision,
        resolve: false,
      },
    });
    await tx.insert(audit).values({
      projectId: row.ticket.projectId,
      actorId: "system",
      action: "ticket.auto_resolve_reminder",
      targetId: id,
      detail: { waitingSince: wait.toISOString(), days: policy.days },
    });
    return true;
  });
}
async function resolve(id: string, now: Date): Promise<boolean> {
  return db().transaction(async (tx) => {
    const row = await locked(tx, id);
    if (!row?.ticket.waitingSince) return false;
    const policy = autoResolveOf(row.project.settings);
    if (
      policy.days === null ||
      row.ticket.waitingSince.getTime() + policy.days * day > now.getTime()
    )
      return false;
    const [changed] = await tx
      .update(tickets)
      .set({
        status: "resolved",
        resolvedAt: now,
        pendingSince: null,
        waitingSince: null,
        revision: sql`${tickets.revision} + 1`,
        updatedAt: now,
      })
      .where(and(eq(tickets.id, id), ne(tickets.status, "resolved")))
      .returning({ id: tickets.id });
    if (!changed) return false;
    // A trace in the conversation that only the team reads.
    await tx.insert(messages).values({
      ticketId: id,
      authorType: "system",
      authorName: row.project.name,
      internal: true,
      markdown: `Resolved automatically: no answer from the customer for ${String(policy.days)} days.`,
      language: "en",
      deliveryState: "internal",
      source: { kind: "auto_resolve" },
    });
    await tx.insert(audit).values({
      projectId: row.ticket.projectId,
      actorId: "system",
      action: "ticket.auto_resolve",
      targetId: id,
      detail: { waitingSince: row.ticket.waitingSince.toISOString(), days: policy.days },
    });
    await emitEvent(tx, row.ticket.projectId, "ticket.status_changed", {
      ticketId: id,
      number: row.ticket.number,
      from: "waiting",
      to: "resolved",
    });
    return true;
  });
}
