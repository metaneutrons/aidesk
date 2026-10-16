import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AiFailure } from "../domain/ai";
import { detectLanguage } from "../domain/language";
import { locales } from "../domain/locale";
import { permits, type Principal } from "../domain/permissions";
import { effectiveText, isTextKey } from "../domain/texts";
import {
  checkProtected,
  plausibleLength,
  translateLimits,
  translatePrompt,
  translateSystem,
} from "../domain/translation";
import { cleanText } from "../domain/untrusted";
import { runAiTask, type AiDeps } from "./ai-run";
import { db } from "./db";
import { audit, tickets } from "./db/schema";
import { DomainError } from "./errors";
import { activeTexts } from "./texts";
// Translations that a person asks for and gets at once, to put into a field and edit: the draft of
// a reply or a note into the language of the customer, and a standard text of a project into the
// other language. Nothing is stored and nothing is sent. They fail alone: a provider that does not
// answer blocks this action and no other work of the desk.
const statusOf: Record<AiFailure, number> = {
  ai_not_configured: 409,
  ai_disabled: 409,
  ai_budget_exceeded: 429,
  ai_timeout: 504,
  ai_quota_exhausted: 402,
  ai_model_unavailable: 409,
  ai_rate_limited: 503,
  ai_provider_error: 502,
};
const language = z.enum(locales);
export const translateDraftInput = z
  .object({ markdown: z.string().trim().min(1).max(translateLimits.chars), language })
  .strict();
export const translateTemplateInput = z.object({ from: language, language }).strict();
async function translate(options: {
  projectId: string;
  task: "message.translate" | "template.translate";
  kind: "message" | "template";
  text: string;
  from: string | null;
  to: string;
  actor: Principal;
  deps: AiDeps;
}): Promise<{ text: string; runId: string }> {
  const boundary = `text-${randomUUID()}`;
  const outcome = await runAiTask(
    {
      projectId: options.projectId,
      task: options.task,
      system: translateSystem({
        boundary,
        from: options.from,
        to: options.to,
        kind: options.kind,
      }),
      prompt: translatePrompt(boundary, cleanText(options.text).text),
      actor: { id: options.actor.id, kind: options.actor.kind },
    },
    options.deps,
  );
  if (!outcome.ok)
    throw new DomainError(outcome.code, statusOf[outcome.code], outcome.retryAfterSeconds);
  const text = cleanText(outcome.text).text.trim();
  // What cannot be shown as a translation is refused, with a code that says why.
  if (outcome.truncated || !plausibleLength(options.text, text))
    throw new DomainError("translation_unusable", 422);
  if (!checkProtected(options.text, text).ok) throw new DomainError("translation_unusable", 422);
  return { text, runId: outcome.runId };
}
// The draft of a reply or a note in the language of the customer. The language of the draft is
// found by the model; a draft that is clearly in the language already is not translated.
export async function translateDraft(
  principal: Principal,
  ticketId: string,
  input: unknown,
  deps: AiDeps = {},
) {
  const request = translateDraftInput.parse(input);
  const [ticket] = await db()
    .select()
    .from(tickets)
    .where(eq(tickets.id, z.uuid().parse(ticketId)));
  if (!ticket || !permits(principal, ticket.projectId, "ticket.read"))
    throw new DomainError("not_found", 404);
  if (
    !permits(principal, ticket.projectId, "ticket.reply") &&
    !permits(principal, ticket.projectId, "ticket.note")
  )
    throw new DomainError("forbidden", 403);
  if (detectLanguage(request.markdown).language === request.language)
    throw new DomainError("conflict", 409);
  const result = await translate({
    projectId: ticket.projectId,
    task: "message.translate",
    kind: "message",
    text: request.markdown,
    from: null,
    to: request.language,
    actor: principal,
    deps,
  });
  await db()
    .insert(audit)
    .values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "draft.translate",
      targetId: ticket.id,
      detail: { runId: result.runId, to: request.language, actorKind: principal.kind },
    });
  return { text: result.text };
}
// A standard text of the project in the other language, as a suggestion to edit and save.
export async function translateTemplate(
  principal: Principal,
  projectId: string,
  key: string,
  input: unknown,
  deps: AiDeps = {},
) {
  const request = translateTemplateInput.parse(input);
  const project = z.uuid().parse(projectId);
  if (!permits(principal, project, "config.read")) throw new DomainError("not_found", 404);
  if (!permits(principal, project, "config.write")) throw new DomainError("forbidden", 403);
  if (!isTextKey(key)) throw new DomainError("not_found", 404);
  if (request.from === request.language) throw new DomainError("conflict", 409);
  const source = effectiveText(key, request.from, await activeTexts(project, request.from));
  const result = await translate({
    projectId: project,
    task: "template.translate",
    kind: "template",
    text: source,
    from: request.from,
    to: request.language,
    actor: principal,
    deps,
  });
  await db()
    .insert(audit)
    .values({
      projectId: project,
      actorId: principal.id,
      action: "template.translate",
      targetId: key,
      detail: {
        runId: result.runId,
        from: request.from,
        to: request.language,
        actorKind: principal.kind,
      },
    });
  return { text: result.text };
}
