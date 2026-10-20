import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { permits, type Principal } from "../domain/permissions";
import {
  retentionOf,
  retentionPreviewInput,
  retentionStep,
  type RetentionCounts,
  type RetentionPeriods,
} from "../domain/retention";
import { db } from "./db";
import {
  aiRuns,
  attachments,
  attachmentTexts,
  audit,
  ingress,
  messages,
  projects,
  tickets,
  translations,
} from "./db/schema";
import { DomainError } from "./errors";
import { eraseTicketsAsSystem, removeObjects } from "./erasure";
// The retention of a project (see `domain/retention.ts`): every period is off until the project sets it. A scheduled
// job (`scanRetention`, called by the worker) removes what is due, in steps of `retentionStep` for each kind and
// project and pass, so a large backlog is worked off over several passes without holding the database. Each kind
// has its own moment to count from:
//   tickets       a ticket that was resolved, or moved to junk, longer ago than the period; an open ticket stays
//   attachments   the file of an attachment older than the period: the file and its extracted text go, the row stays
//                 and says that the file was removed
//   originals     the original of a mail older than the period: the file goes, the entry of the mail stays (it
//                 recognizes a mail that is read again) without the parsed sender and subject
//   translations  a translation older than the period
//   aiRuns        the record of a run of a model older than the period
// What is removed leaves an audit entry with counts and no content. A dry run (`previewRetention`) counts what
// periods would remove now, which a person sees before setting or shortening one.
const day = 86_400_000;
const cutoff = (days: number, now: Date) => new Date(now.getTime() - days * day);
const none: RetentionCounts = {
  tickets: 0,
  attachments: 0,
  originals: 0,
  translations: 0,
  aiRuns: 0,
};
function dueTickets(project: string, days: number, now: Date) {
  const before = cutoff(days, now);
  return and(
    eq(tickets.projectId, project),
    or(
      and(
        eq(tickets.status, "resolved"),
        isNotNull(tickets.resolvedAt),
        lt(tickets.resolvedAt, before),
      ),
      and(isNotNull(tickets.junkAt), lt(tickets.junkAt, before)),
    ),
  );
}
const dueAttachments = (project: string, days: number, now: Date) =>
  and(
    eq(attachments.projectId, project),
    isNotNull(attachments.objectKey),
    lt(attachments.createdAt, cutoff(days, now)),
  );
const dueMessageOriginals = (project: string, days: number, now: Date) =>
  and(
    isNotNull(messages.rawObjectKey),
    lt(messages.createdAt, cutoff(days, now)),
    inArray(
      messages.ticketId,
      db().select({ id: tickets.id }).from(tickets).where(eq(tickets.projectId, project)),
    ),
  );
// An entry of mail that is still to be read keeps its original; so does one that has none any more.
const dueIngressOriginals = (project: string, days: number, now: Date) =>
  and(
    eq(ingress.projectId, project),
    ne(ingress.rawObjectKey, ""),
    ne(ingress.state, "queued"),
    ne(ingress.state, "review"),
    lt(ingress.receivedAt, cutoff(days, now)),
  );
const dueTranslations = (project: string, days: number, now: Date) =>
  and(
    lt(translations.createdAt, cutoff(days, now)),
    inArray(
      translations.messageId,
      db()
        .select({ id: messages.id })
        .from(messages)
        .where(
          inArray(
            messages.ticketId,
            db().select({ id: tickets.id }).from(tickets).where(eq(tickets.projectId, project)),
          ),
        ),
    ),
  );
const dueRuns = (project: string, days: number, now: Date) =>
  and(eq(aiRuns.projectId, project), lt(aiRuns.createdAt, cutoff(days, now)));
const count = async (query: Promise<{ count: number }[]>) => (await query)[0]?.count ?? 0;
// What the periods would remove now.
export async function countDue(
  project: string,
  periods: RetentionPeriods,
  now: Date = new Date(),
): Promise<RetentionCounts> {
  const total = sql<number>`count(*)::int`;
  const found: RetentionCounts = { ...none };
  if (periods.tickets !== null)
    found.tickets = await count(
      db()
        .select({ count: total })
        .from(tickets)
        .where(dueTickets(project, periods.tickets, now)),
    );
  if (periods.attachments !== null)
    found.attachments = await count(
      db()
        .select({ count: total })
        .from(attachments)
        .where(dueAttachments(project, periods.attachments, now)),
    );
  if (periods.originals !== null)
    found.originals =
      (await count(
        db()
          .select({ count: total })
          .from(messages)
          .where(dueMessageOriginals(project, periods.originals, now)),
      )) +
      (await count(
        db()
          .select({ count: total })
          .from(ingress)
          .where(dueIngressOriginals(project, periods.originals, now)),
      ));
  if (periods.translations !== null)
    found.translations = await count(
      db()
        .select({ count: total })
        .from(translations)
        .where(dueTranslations(project, periods.translations, now)),
    );
  if (periods.aiRuns !== null)
    found.aiRuns = await count(
      db()
        .select({ count: total })
        .from(aiRuns)
        .where(dueRuns(project, periods.aiRuns, now)),
    );
  return found;
}
export async function previewRetention(principal: Principal, projectId: string, input: unknown) {
  const project = z.uuid().parse(projectId);
  if (!permits(principal, project, "config.read")) throw new DomainError("not_found", 404);
  const [row] = await db()
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, project));
  if (!row) throw new DomainError("not_found", 404);
  const periods = retentionPreviewInput.parse(input ?? retentionOf(row.settings));
  return { periods, due: await countDue(project, periods) };
}
// One pass for one project: removes up to a step of each kind that is due.
export async function runRetention(
  project: string,
  now: Date = new Date(),
  step = retentionStep,
): Promise<RetentionCounts> {
  const [row] = await db()
    .select({ settings: projects.settings, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, project));
  if (!row || row.archivedAt) return { ...none };
  const periods = retentionOf(row.settings);
  const done: RetentionCounts = { ...none };
  if (periods.tickets !== null) {
    const ids = (
      await db()
        .select({ id: tickets.id })
        .from(tickets)
        .where(dueTickets(project, periods.tickets, now))
        .orderBy(asc(tickets.createdAt))
        .limit(step)
    ).map((entry) => entry.id);
    if (ids.length) {
      const result = await eraseTicketsAsSystem(project, ids, {
        scope: "retention",
        periodDays: periods.tickets,
      });
      done.tickets = result.counts.tickets;
    }
  }
  const files = step * 5;
  if (periods.attachments !== null) {
    const rows = await db()
      .select({ id: attachments.id, key: attachments.objectKey })
      .from(attachments)
      .where(dueAttachments(project, periods.attachments, now))
      .orderBy(asc(attachments.createdAt))
      .limit(files);
    if (rows.length) {
      const ids = rows.map((entry) => entry.id);
      await db().transaction(async (tx) => {
        await tx.delete(attachmentTexts).where(inArray(attachmentTexts.attachmentId, ids));
        await tx
          .update(attachments)
          .set({ objectKey: null, refusal: "removed_by_retention" })
          .where(inArray(attachments.id, ids));
      });
      await removeObjects(rows.flatMap((entry) => (entry.key ? [entry.key] : [])));
      done.attachments = rows.length;
    }
  }
  if (periods.originals !== null) {
    const fromMessages = await db()
      .select({ id: messages.id, key: messages.rawObjectKey })
      .from(messages)
      .where(dueMessageOriginals(project, periods.originals, now))
      .orderBy(asc(messages.createdAt))
      .limit(files);
    const fromIngress = await db()
      .select({ id: ingress.id, key: ingress.rawObjectKey })
      .from(ingress)
      .where(dueIngressOriginals(project, periods.originals, now))
      .orderBy(asc(ingress.receivedAt))
      .limit(files);
    if (fromMessages.length || fromIngress.length) {
      await db().transaction(async (tx) => {
        if (fromMessages.length)
          await tx
            .update(messages)
            .set({ rawObjectKey: null })
            .where(
              inArray(
                messages.id,
                fromMessages.map((entry) => entry.id),
              ),
            );
        if (fromIngress.length)
          await tx
            .update(ingress)
            .set({ rawObjectKey: "", parsed: null })
            .where(
              inArray(
                ingress.id,
                fromIngress.map((entry) => entry.id),
              ),
            );
      });
      await removeObjects(
        [...fromMessages, ...fromIngress].flatMap((entry) => (entry.key ? [entry.key] : [])),
      );
      done.originals = fromMessages.length + fromIngress.length;
    }
  }
  if (periods.translations !== null) {
    const rows = await db()
      .select({ id: translations.id })
      .from(translations)
      .where(dueTranslations(project, periods.translations, now))
      .limit(files);
    if (rows.length) {
      await db()
        .delete(translations)
        .where(
          inArray(
            translations.id,
            rows.map((entry) => entry.id),
          ),
        );
      done.translations = rows.length;
    }
  }
  if (periods.aiRuns !== null) {
    const rows = await db()
      .select({ id: aiRuns.id })
      .from(aiRuns)
      .where(dueRuns(project, periods.aiRuns, now))
      .limit(files);
    if (rows.length) {
      await db()
        .delete(aiRuns)
        .where(
          inArray(
            aiRuns.id,
            rows.map((entry) => entry.id),
          ),
        );
      done.aiRuns = rows.length;
    }
  }
  if (Object.values(done).some((value) => value > 0))
    await db()
      .insert(audit)
      .values({
        projectId: project,
        actorId: "system",
        action: "retention.run",
        targetId: project,
        detail: { counts: done, periods },
      });
  return done;
}
// Every project that has a period set and is not archived.
export async function scanRetention(now: Date = new Date(), step = retentionStep) {
  const rows = await db()
    .select({ id: projects.id, settings: projects.settings })
    .from(projects)
    .where(isNull(projects.archivedAt));
  const totals: RetentionCounts = { ...none };
  for (const row of rows) {
    if (Object.values(retentionOf(row.settings)).every((value) => value === null)) continue;
    const done = await runRetention(row.id, now, step);
    for (const key of Object.keys(totals) as (keyof RetentionCounts)[]) totals[key] += done[key];
  }
  return totals;
}
