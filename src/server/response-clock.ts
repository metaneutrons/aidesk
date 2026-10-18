import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { defaultOverdueHours, defaultWarnHours, limitsOf } from "../domain/response-clock";
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
const warnLimit = sql`least(coalesce((${projects.settings}->>'warnHours')::int, ${defaultWarnHours}), coalesce((${projects.settings}->>'overdueHours')::int, ${defaultOverdueHours}))`;
const overdueLimit = sql`coalesce((${projects.settings}->>'overdueHours')::int, ${defaultOverdueHours})`;
export async function scanResponseClock(
  now: Date = new Date(),
  limit = 100,
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
        or(due(tickets.warnedFor, warnLimit), due(tickets.overdueFor, overdueLimit)),
      ),
    )
    .orderBy(asc(tickets.pendingSince))
    .limit(limit);
  const sent = { warned: 0, overdue: 0 };
  for (const { id } of candidates)
    await db().transaction(async (tx) => {
      const [row] = await tx
        .select({ ticket: tickets, settings: projects.settings })
        .from(tickets)
        .innerJoin(projects, eq(projects.id, tickets.projectId))
        .where(eq(tickets.id, id))
        .for("update", { of: tickets });
      const start = row?.ticket.pendingSince;
      if (!row || !start || row.ticket.junkAt !== null) return;
      const limits = limitsOf(row.settings);
      const age = now.getTime() - start.getTime();
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
  return sent;
}
