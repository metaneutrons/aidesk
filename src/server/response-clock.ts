import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { calendarOf, clockMillis } from "../domain/business-hours";
import {
  defaultOverdueHours,
  defaultWarnHours,
  limitsOf,
  priorityLimitKey,
} from "../domain/response-clock";
import { priorities, priorityOf } from "../domain/triage";
import { db } from "./db";
import { projects, tickets } from "./db/schema";
import { emitEvent } from "./webhooks";
// The events of the response clock: a ticket that has waited for an answer as long as the
// warning limit of its project, and as long as its overdue limit. Each is sent once per cycle,
// and a cycle is the time from the first unanswered message of the customer to the reply that
// was sent. The marker of a sent event is the start of the cycle (`warned_for`, `overdue_for`),
// stored in the transaction that queues the event, so that a restart or a repeated scan sends
// nothing twice, and a new cycle, which has a new start, can send again.
//
// A ticket is looked at again under a lock before an event is sent: a reply that ends the
// cycle while the scan runs wins, and no event follows it.
//
// A project with business hours counts business time. The database only knows calendar time, which is never
// shorter, so it names the tickets that may be due, and the exact age is measured on the ticket under the lock.
// The scan looks at more tickets than it may handle, because tickets that wait outside the business hours are
// not due and must not crowd out those that are.
// The limits in hours as the database reads them, for the priority that the ticket has: what `limitsOf` says.
const setting = (key: string) => sql`(${projects.settings}->>${sql.raw(`'${key}'`)})::int`;
const byPriority = (kind: "warn" | "overdue", base: ReturnType<typeof sql>) =>
  sql`case ${tickets.priority} ${sql.join(
    priorities
      .filter((priority) => priority !== "normal")
      .map(
        (priority) =>
          sql`when ${priority} then coalesce(${setting(priorityLimitKey(kind, priorityOf(priority)))}, ${base})`,
      ),
    sql` `,
  )} else ${base} end`;
export const overdueLimit = byPriority(
  "overdue",
  sql`coalesce(${setting("overdueHours")}, ${defaultOverdueHours})`,
);
export const warnLimit = sql`least(${byPriority(
  "warn",
  sql`coalesce(${setting("warnHours")}, ${defaultWarnHours})`,
)}, ${overdueLimit})`;
const lookAhead = 2000;
export async function scanResponseClock(
  now: Date = new Date(),
  limit = 100,
  // Only these projects; a test that uses its own time uses it to leave the tickets of others alone.
  only?: readonly string[],
): Promise<{ warned: number; overdue: number }> {
  const due = (
    marker: typeof tickets.warnedFor | typeof tickets.overdueFor,
    hours: typeof warnLimit,
  ) =>
    and(
      sql`${marker} is distinct from ${tickets.pendingSince}`,
      sql`${tickets.pendingSince} <= ${now.toISOString()}::timestamptz - make_interval(hours => ${hours})`,
    );
  const candidates = await db()
    .select({ id: tickets.id })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(
      and(
        isNotNull(tickets.pendingSince),
        isNull(tickets.junkAt),
        isNull(projects.archivedAt),
        only ? inArray(tickets.projectId, [...only]) : undefined,
        or(due(tickets.warnedFor, warnLimit), due(tickets.overdueFor, overdueLimit)),
      ),
    )
    .orderBy(asc(tickets.pendingSince))
    .limit(Math.max(limit, lookAhead));
  const sent = { warned: 0, overdue: 0 };
  let handled = 0;
  for (const { id } of candidates) {
    if (handled >= limit) break;
    const before = sent.warned + sent.overdue;
    await db().transaction(async (tx) => {
      const [row] = await tx
        .select({ ticket: tickets, settings: projects.settings })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .where(eq(tickets.id, id))
        .for("update", { of: tickets });
      const start = row?.ticket.pendingSince;
      if (!row || !start || row.ticket.junkAt !== null) return;
      const limits = limitsOf(row.settings, priorityOf(row.ticket.priority));
      const age = clockMillis(start, now, calendarOf(row.settings));
      const facts = {
        ticketId: row.ticket.id,
        number: row.ticket.number,
        pendingSince: start.toISOString(),
      };
      if (
        age >= limits.warnHours * 3_600_000 &&
        row.ticket.warnedFor?.getTime() !== start.getTime()
      ) {
        await emitEvent(tx, row.ticket.projectId, "ticket.warning", {
          ...facts,
          limitHours: limits.warnHours,
        });
        await tx.update(tickets).set({ warnedFor: start }).where(eq(tickets.id, id));
        sent.warned += 1;
      }
      if (
        age >= limits.overdueHours * 3_600_000 &&
        row.ticket.overdueFor?.getTime() !== start.getTime()
      ) {
        await emitEvent(tx, row.ticket.projectId, "ticket.overdue", {
          ...facts,
          limitHours: limits.overdueHours,
        });
        await tx.update(tickets).set({ overdueFor: start }).where(eq(tickets.id, id));
        sent.overdue += 1;
      }
    });
    if (sent.warned + sent.overdue > before) handled += 1;
  }
  return sent;
}
