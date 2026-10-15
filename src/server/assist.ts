import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  assistInput,
  assistKey,
  assistPrompt,
  assistSystem,
  assistTask,
  type AssistMessage,
} from "../domain/assist";
import type { AiFailure } from "../domain/ai";
import { allowedProjectIds, permits, type Principal } from "../domain/permissions";
import { effectiveText } from "../domain/texts";
import { cleanText } from "../domain/untrusted";
import { runAiTask, type AiDeps } from "./ai-run";
import { db } from "./db";
import { audit, messages, tickets } from "./db/schema";
import { DomainError } from "./errors";
import { activeTexts } from "./texts";
// How a run that ended without an answer is shown to the caller.
const statusOf: Record<AiFailure, number> = {
  ai_not_configured: 409,
  ai_disabled: 409,
  ai_budget_exceeded: 429,
  ai_timeout: 504,
  ai_model_unavailable: 409,
  ai_rate_limited: 503,
  ai_provider_error: 502,
};
// A draft of a reply or of an internal note for a ticket, written by the model of the
// project from the conversation. It needs the right to write what it drafts and to
// read the ticket. The conversation and the typed text go to the provider of the task
// as data between markers that cannot be guessed; the standard instruction is the
// text of the project (assist.reply or assist.note) and cannot drop the guard that
// follows it. A reply draft leaves out the internal notes, so that what is private is
// not carried into a text for the customer. The audit entry says that a draft was
// made and under which run, and holds neither the instruction, the typed text nor
// the draft.
export async function assistDraft(
  principal: Principal,
  ticketId: string,
  input: unknown,
  deps: AiDeps = {},
) {
  const request = assistInput.parse(input);
  const readable = allowedProjectIds(principal, "ticket.read");
  if (!readable.length) throw new DomainError("not_found", 404);
  const id = z.uuid().parse(ticketId);
  const [ticket] = await db().select().from(tickets).where(eq(tickets.id, id)).limit(1);
  if (!ticket || !readable.includes(ticket.projectId)) throw new DomainError("not_found", 404);
  if (
    !permits(principal, ticket.projectId, request.mode === "reply" ? "ticket.reply" : "ticket.note")
  )
    throw new DomainError("forbidden", 403);
  // A ticket in junk gets no public reply, so no draft of one.
  if (request.mode === "reply" && ticket.junkAt) throw new DomainError("conflict", 409);
  const rows = await db()
    .select()
    .from(messages)
    .where(eq(messages.ticketId, ticket.id))
    .orderBy(asc(messages.createdAt));
  const conversation: AssistMessage[] = rows.flatMap((row) => {
    // Drafts of agents and discarded ones were not said to the customer.
    if (row.deliveryState === "draft" || row.deliveryState === "discarded") return [];
    if (row.authorType === "system") return [];
    if (row.internal && request.mode === "reply") return [];
    const role = row.internal ? "note" : row.authorType === "customer" ? "customer" : "team";
    return [{ role, name: row.authorName, at: row.createdAt, text: row.markdown }];
  });
  const boundary = `ticket-data-${randomUUID()}`;
  const standard = effectiveText(
    assistKey[request.mode],
    ticket.language,
    await activeTexts(ticket.projectId, ticket.language),
  );
  const outcome = await runAiTask(
    {
      projectId: ticket.projectId,
      task: assistTask[request.mode],
      system: assistSystem({ standard, instruction: request.instruction, boundary }),
      prompt: assistPrompt({
        boundary,
        number: ticket.number,
        subject: ticket.subject,
        customer: ticket.requesterName,
        language: ticket.language,
        messages: conversation,
        current: request.current,
      }),
      actor: { id: principal.id, kind: principal.kind },
    },
    deps,
  );
  if (!outcome.ok) throw new DomainError(outcome.code, statusOf[outcome.code]);
  // What a model returns is cleaned of invisible characters like any text from outside.
  const text = cleanText(outcome.text).text.trim();
  if (!text) throw new DomainError("ai_provider_error", statusOf.ai_provider_error);
  await db()
    .insert(audit)
    .values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "draft.assist",
      targetId: ticket.id,
      detail: {
        mode: request.mode,
        runId: outcome.runId,
        actorKind: principal.kind,
        withInstruction: Boolean(request.instruction),
        withText: Boolean(request.current),
        truncated: outcome.truncated,
      },
    });
  return { text, truncated: outcome.truncated };
}
