import { and, asc, eq, like, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { audit, jobs, messages, tickets, translations } from "./db/schema";
import { DomainError } from "./errors";
import { markdownHtml } from "./markdown";
import { locales } from "../domain/locale";
import { checkProtected } from "../domain/translation";
import { permits, type Principal } from "../domain/permissions";
// Derived translations of a message. They never replace the source, are never
// a message of their own, are read with the rights to read the source, and
// follow the source's revision: an edit makes the earlier ones stale. The
// translating provider itself is part of M4; it reports through
// completeTranslation and failTranslation.
export const translationJob = "translation.run";
const id = z.uuid();
async function sourceOf(
  principal: Principal,
  messageId: string,
  action: "ticket.read" | "ticket.reply" | "ticket.note",
) {
  const [found] = await db()
    .select({ message: messages, ticket: tickets })
    .from(messages)
    .innerJoin(tickets, eq(tickets.id, messages.ticketId))
    .where(eq(messages.id, id.parse(messageId)));
  if (!found || !permits(principal, found.ticket.projectId, "ticket.read"))
    throw new DomainError("not_found", 404);
  if (!permits(principal, found.ticket.projectId, action)) throw new DomainError("forbidden", 403);
  return found;
}
// Queues the translation of the current revision of a message into one
// language. Asking again returns the same record.
export async function requestTranslation(
  principal: Principal,
  messageId: string,
  language: unknown,
) {
  const target = z.enum(locales).parse(language);
  const { message, ticket } = await sourceOf(principal, messageId, "ticket.read");
  if (ticket.junkAt !== null) throw new DomainError("conflict", 409);
  if (message.language.toLowerCase().split("-")[0] === target)
    throw new DomainError("conflict", 409);
  return db().transaction(async (tx) => {
    const inserted = await tx
      .insert(translations)
      .values({ messageId: message.id, sourceRevision: message.revision, language: target })
      .onConflictDoNothing()
      .returning({ id: translations.id });
    const [record] = await tx
      .select()
      .from(translations)
      .where(
        and(
          eq(translations.messageId, message.id),
          eq(translations.sourceRevision, message.revision),
          eq(translations.language, target),
        ),
      )
      .for("update");
    if (!record) throw new DomainError("conflict", 409);
    // A failed one is tried again; ready and pending ones are returned as they are.
    const again = record.status === "failed";
    if (again)
      await tx
        .update(translations)
        .set({ status: "queued", markdown: null, provenance: {} })
        .where(eq(translations.id, record.id));
    if (inserted.length > 0 || again) {
      // One job per try: asking again after a failure is a new job, asking while it waits is not.
      const [tries] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(like(jobs.dedupKey, `translation:${record.id}:%`));
      await tx.insert(jobs).values({
        projectId: ticket.projectId,
        type: translationJob,
        dedupKey: `translation:${record.id}:${String((tries?.count ?? 0) + 1)}`,
        payload: { translationId: record.id, actorId: principal.id, actorKind: principal.kind },
      });
    }
    return {
      id: record.id,
      status: again ? ("queued" as const) : record.status,
      language: record.language,
    };
  });
}
// The provider's result. A result for an outdated revision is discarded, and
// one that changed code, links, addresses or placeholders is a failure.
export async function completeTranslation(
  translationId: string,
  result: {
    markdown: string;
    provenance?: Record<string, unknown>;
    profile?: { id: string; revision: number };
  },
) {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select({ translation: translations, message: messages })
      .from(translations)
      .innerJoin(messages, eq(messages.id, translations.messageId))
      .where(eq(translations.id, id.parse(translationId)))
      .for("update", { of: translations });
    if (row?.translation.status !== "queued") throw new DomainError("conflict", 409);
    if (row.message.revision !== row.translation.sourceRevision) {
      await tx
        .update(translations)
        .set({ status: "stale", markdown: null })
        .where(eq(translations.id, row.translation.id));
      return { status: "stale" as const };
    }
    const check = checkProtected(row.message.markdown, result.markdown);
    if (!check.ok || !result.markdown.trim()) {
      await tx
        .update(translations)
        .set({
          status: "failed",
          markdown: null,
          provenance: {
            ...result.provenance,
            error: "protected_content_changed",
            missing: check.missing.length,
            added: check.added.length,
            numbersMissing: check.numbersMissing.length,
            numbersAdded: check.numbersAdded.length,
          },
        })
        .where(eq(translations.id, row.translation.id));
      return { status: "failed" as const };
    }
    await tx
      .update(translations)
      .set({
        status: "ready",
        markdown: result.markdown,
        provenance: result.provenance ?? {},
        ...(result.profile
          ? { profileId: result.profile.id, profileRevision: result.profile.revision }
          : {}),
      })
      .where(eq(translations.id, row.translation.id));
    return { status: "ready" as const };
  });
}
export async function failTranslation(translationId: string, code: string) {
  const changed = await db()
    .update(translations)
    .set({ status: "failed", markdown: null, provenance: { error: code.slice(0, 64) } })
    .where(and(eq(translations.id, id.parse(translationId)), eq(translations.status, "queued")))
    .returning({ id: translations.id });
  if (!changed.length) throw new DomainError("conflict", 409);
  return { status: "failed" as const };
}
// Translations of a message as its readers see them. Pending, failed and stale
// ones are listed without text; the source stays usable in every case.
export async function listTranslations(principal: Principal, messageId: string) {
  const { message } = await sourceOf(principal, messageId, "ticket.read");
  const rows = await db()
    .select()
    .from(translations)
    .where(eq(translations.messageId, message.id))
    .orderBy(asc(translations.createdAt));
  return rows.map((row) => ({
    id: row.id,
    language: row.language,
    sourceRevision: row.sourceRevision,
    current: row.sourceRevision === message.revision,
    status: row.status,
    // What a translation is: made by a machine, with the model and the revision of the profile that
    // made it, or the reason why there is none.
    machine: true as const,
    model: typeof row.provenance.model === "string" ? row.provenance.model : null,
    profileRevision: row.profileRevision,
    error:
      row.status === "failed" && typeof row.provenance.error === "string"
        ? row.provenance.error
        : null,
    markdown: row.status === "ready" ? row.markdown : null,
    html: row.status === "ready" && row.markdown ? markdownHtml(row.markdown) : null,
  }));
}
// A correction of the source text (for example of a wrong extraction). The
// message gets a new revision and every translation of an earlier one becomes
// stale and loses its text. Only messages that were not sent can be corrected.
export async function correctMessage(principal: Principal, messageId: string, markdown: unknown) {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
  const text = z.string().trim().min(1).max(100_000).parse(markdown);
  const probe = await sourceOf(principal, messageId, "ticket.read");
  const action = probe.message.internal ? "ticket.note" : "ticket.reply";
  const { message, ticket } = await sourceOf(principal, messageId, action);
  if (!["received", "internal"].includes(message.deliveryState))
    throw new DomainError("conflict", 409);
  return db().transaction(async (tx) => {
    const [updated] = await tx
      .update(messages)
      .set({ markdown: text, revision: message.revision + 1 })
      .where(and(eq(messages.id, message.id), eq(messages.revision, message.revision)))
      .returning({ revision: messages.revision });
    if (!updated) throw new DomainError("conflict", 409);
    await tx
      .update(translations)
      .set({ status: "stale", markdown: null })
      .where(
        and(
          eq(translations.messageId, message.id),
          lt(translations.sourceRevision, updated.revision),
        ),
      );
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "message.correct",
      targetId: message.id,
    });
    return { revision: updated.revision };
  });
}
// Removes the derived content of a message; the source stays.
export async function deleteTranslations(principal: Principal, messageId: string) {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
  const { message, ticket } = await sourceOf(principal, messageId, "ticket.reply");
  return db().transaction(async (tx) => {
    const removed = await tx
      .delete(translations)
      .where(eq(translations.messageId, message.id))
      .returning({ id: translations.id });
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "translation.delete",
      targetId: message.id,
    });
    return { deleted: removed.length };
  });
}
