import { and, count, eq, gte, isNotNull, sql, sum } from "drizzle-orm";
import { z } from "zod";
import { permits, type Principal } from "../domain/permissions";
import { usageQuery } from "../domain/usage";
import { db } from "./db";
import { aiBudgets, aiProfiles, aiRuns, attachments, messages, tickets } from "./db/schema";
import { DomainError } from "./errors";
// What a project has used: the calls of the AI by task and day (how many, how they ended, the tokens, the share of the
// daily budget that was used and what was left), the mail that came in and went out by day, and the files that are
// stored. The budget shown is the one that the task profile has now; a budget that was changed earlier is not kept.
// The right to read the configuration reads it (an archived project can be read too).
const id = z.uuid();
const day = (date: Date) => date.toISOString().slice(0, 10);
export async function getUsage(principal: Principal, projectId: string, input: unknown) {
  const project = id.parse(projectId);
  if (!permits(principal, project, "config.read")) throw new DomainError("not_found", 404);
  const { days } = usageQuery.parse(input);
  const today = new Date();
  const from = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1)),
  );
  const dayOf = (column: ReturnType<typeof sql>) =>
    sql<string>`to_char(${column} at time zone 'utc', 'YYYY-MM-DD')`;
  const [runRows, budgetRows, profileRows, mailRows, storedRows, rawRows] = await Promise.all([
    db()
      .select({
        day: dayOf(sql`${aiRuns.createdAt}`),
        task: aiRuns.task,
        outcome: aiRuns.outcome,
        calls: count(),
        input: sum(aiRuns.inputTokens),
        output: sum(aiRuns.outputTokens),
      })
      .from(aiRuns)
      .where(and(eq(aiRuns.projectId, project), gte(aiRuns.createdAt, from)))
      .groupBy(sql`1`, aiRuns.task, aiRuns.outcome),
    db()
      .select({ day: aiBudgets.day, task: aiBudgets.task, charged: aiBudgets.charged })
      .from(aiBudgets)
      .where(and(eq(aiBudgets.projectId, project), gte(aiBudgets.day, day(from)))),
    db()
      .select({ task: aiProfiles.task, budget: aiProfiles.dailyTokenBudget })
      .from(aiProfiles)
      .where(eq(aiProfiles.projectId, project)),
    db()
      .select({
        day: dayOf(sql`${messages.createdAt}`),
        received: sql<number>`(count(*) filter (where ${messages.authorType} = 'customer'))::int`,
        sent: sql<number>`(count(*) filter (where ${messages.authorType} <> 'customer' and ${messages.deliveryState} = 'sent' and not ${messages.internal}))::int`,
      })
      .from(messages)
      .innerJoin(tickets, eq(tickets.id, messages.ticketId))
      .where(and(eq(tickets.projectId, project), gte(messages.createdAt, from)))
      .groupBy(sql`1`),
    db()
      .select({ files: count(), bytes: sum(attachments.size) })
      .from(attachments)
      .where(and(eq(attachments.projectId, project), isNotNull(attachments.objectKey))),
    db()
      .select({ rawMails: count() })
      .from(messages)
      .innerJoin(tickets, eq(tickets.id, messages.ticketId))
      .where(and(eq(tickets.projectId, project), isNotNull(messages.rawObjectKey))),
  ]);
  const budgetOf = new Map(profileRows.map((row) => [row.task, row.budget]));
  const charged = new Map(budgetRows.map((row) => [`${row.day}|${row.task}`, row.charged]));
  const cells = new Map<
    string,
    {
      day: string;
      task: string;
      calls: number;
      outcomes: Record<string, number>;
      inputTokens: number;
      outputTokens: number;
    }
  >();
  for (const row of runRows) {
    const key = `${row.day}|${row.task}`;
    const cell = cells.get(key) ?? {
      day: row.day,
      task: row.task,
      calls: 0,
      outcomes: {},
      inputTokens: 0,
      outputTokens: 0,
    };
    cell.calls += row.calls;
    cell.outcomes[row.outcome] = (cell.outcomes[row.outcome] ?? 0) + row.calls;
    cell.inputTokens += Number(row.input ?? 0);
    cell.outputTokens += Number(row.output ?? 0);
    cells.set(key, cell);
  }
  // A day with a charge and no run (a run that was refused for the budget leaves a run, a charge without one cannot be) is shown too.
  for (const row of budgetRows)
    if (!cells.has(`${row.day}|${row.task}`))
      cells.set(`${row.day}|${row.task}`, {
        day: row.day,
        task: row.task,
        calls: 0,
        outcomes: {},
        inputTokens: 0,
        outputTokens: 0,
      });
  const ai = [...cells.values()]
    .sort((a, b) => (a.day === b.day ? a.task.localeCompare(b.task) : b.day.localeCompare(a.day)))
    .map((cell) => {
      const used = charged.get(`${cell.day}|${cell.task}`) ?? 0;
      const budget = budgetOf.get(cell.task) ?? null;
      return {
        ...cell,
        charged: used,
        budget,
        left: budget === null ? null : Math.max(budget - used, 0),
      };
    });
  const mail = mailRows
    .map((row) => ({ day: row.day, received: row.received, sent: row.sent }))
    .sort((a, b) => b.day.localeCompare(a.day));
  return {
    days,
    from: day(from),
    to: day(today),
    ai,
    mail,
    storage: {
      files: storedRows[0]?.files ?? 0,
      bytes: Number(storedRows[0]?.bytes ?? 0),
      rawMails: rawRows[0]?.rawMails ?? 0,
    },
  };
}
