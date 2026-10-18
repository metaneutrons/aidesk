import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  plausibleLength,
  translateLimits,
  translatePrompt,
  translateSystem,
} from "../domain/translation";
import { cleanText } from "../domain/untrusted";
import { runAiTask, type AiDeps } from "../server/ai-run";
import { db } from "../server/db";
import { actionsOf } from "../server/grants";
import {
  agents,
  aiProfiles,
  aiRuns,
  messages,
  tickets,
  translations,
  user,
} from "../server/db/schema";
import { completeTranslation, failTranslation, translationJob } from "../server/translation";
import { claimJob } from "./claim";
// The job that translates one message into one language. The translation is a derived record: it
// never replaces the source and never sends or resets anything. The checks are made again here:
// the message may have been corrected since (the record is stale then), the ticket may have gone
// to junk, and the person or agent that asked may have lost the right to read it.
const payload = z.object({
  translationId: z.uuid(),
  actorId: z.string(),
  actorKind: z.enum(["human", "agent"]),
});
const leaseMs = 5 * 60 * 1000;
async function mayRead(actor: z.infer<typeof payload>, projectId: string): Promise<boolean> {
  if (actor.actorKind === "agent") {
    const [agent] = await db().select().from(agents).where(eq(agents.id, actor.actorId));
    return (
      agent?.active === true &&
      agent.projectId === projectId &&
      agent.expiresAt > new Date() &&
      agent.actions.includes("ticket.read")
    );
  }
  const [member] = await db()
    .select({ active: user.active })
    .from(user)
    .where(eq(user.id, actor.actorId));
  return (
    member?.active === true &&
    ((await actionsOf(actor.actorId, projectId))?.includes("ticket.read") ?? false)
  );
}
export async function runTranslations(
  scope?: { projectId: string },
  deps: AiDeps = {},
): Promise<boolean> {
  const claimed = await claimJob(translationJob, leaseMs, scope);
  if (!claimed) return false;
  const { job, finish, retry } = claimed;
  const parsed = payload.safeParse(job.payload);
  const [row] = parsed.success
    ? await db()
        .select({ translation: translations, message: messages, ticket: tickets })
        .from(translations)
        .innerJoin(messages, eq(messages.id, translations.messageId))
        .innerJoin(tickets, eq(tickets.id, messages.ticketId))
        .where(eq(translations.id, parsed.data.translationId))
    : [];
  if (!parsed.success || !row) {
    await finish(
      { status: "review", leaseUntil: null, lastErrorCode: "translation_missing" },
      "translation_missing",
    );
    return true;
  }
  const done = async (outcome: string) =>
    finish({ status: "succeeded", leaseUntil: null }, outcome);
  const failed = async (code: string) => {
    await failTranslation(row.translation.id, code).catch(() => undefined);
    await done(code);
    return true;
  };
  // Somebody else finished it, or it was removed and asked for again: nothing to do.
  if (row.translation.status !== "queued") {
    await done("not_queued");
    return true;
  }
  if (row.message.revision !== row.translation.sourceRevision) {
    await db()
      .update(translations)
      .set({ status: "stale", markdown: null })
      .where(and(eq(translations.id, row.translation.id), eq(translations.status, "queued")));
    await done("stale");
    return true;
  }
  if (row.ticket.junkAt !== null) return failed("ticket_junk");
  if (!(await mayRead(parsed.data, row.ticket.projectId))) return failed("not_allowed");
  if (row.message.markdown.length > translateLimits.chars) return failed("context_limit");
  const boundary = `text-${randomUUID()}`;
  const outcome = await runAiTask(
    {
      projectId: row.ticket.projectId,
      task: "message.translate",
      system: translateSystem({
        boundary,
        from: row.message.language,
        to: row.translation.language,
        kind: "message",
      }),
      prompt: translatePrompt(boundary, cleanText(row.message.markdown).text),
      actor: { id: parsed.data.actorId, kind: parsed.data.actorKind },
    },
    deps,
  );
  if (!outcome.ok) {
    // A limit that passes may be waited for; every other failure is shown on the record, and the
    // person asks again when they want to: a request that may have been accepted is not repeated.
    if (outcome.refused && outcome.code === "ai_rate_limited" && job.attempts < 3) {
      await retry("ai_rate_limited");
      return true;
    }
    return failed(outcome.code);
  }
  const text = cleanText(outcome.text).text.trim();
  if (outcome.truncated) return failed("truncated");
  if (!plausibleLength(row.message.markdown, text)) return failed("implausible_length");
  const [run] = outcome.runId
    ? await db().select().from(aiRuns).where(eq(aiRuns.id, outcome.runId))
    : [];
  const [profile] = await db()
    .select({ id: aiProfiles.id })
    .from(aiProfiles)
    .where(
      and(eq(aiProfiles.projectId, row.ticket.projectId), eq(aiProfiles.task, "message.translate")),
    );
  await completeTranslation(row.translation.id, {
    markdown: text,
    provenance: {
      machine: true,
      task: "message.translate",
      model: outcome.model,
      runId: outcome.runId,
      from: row.message.language,
      to: row.translation.language,
    },
    ...(profile && run?.profileVersion
      ? { profile: { id: profile.id, revision: run.profileVersion } }
      : {}),
  }).catch(() => undefined);
  await done("translated");
  return true;
}
