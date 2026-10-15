import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { ModelMessage } from "ai";
import { z, ZodError } from "zod";
import {
  agentKey,
  agentLimits,
  agentPrompt,
  agentSystem,
  agentTools,
  isAgentTool,
  type AgentMessage,
} from "../domain/agent";
import { effectiveText } from "../domain/texts";
import { permits, type Principal } from "../domain/permissions";
import { endRun, runJob, staleReason, type RunState } from "../server/agent-runs";
import { runAiTask, type AiDeps, type AiOutcome } from "../server/ai-run";
import { db } from "../server/db";
import {
  agentRuns,
  agents,
  attachments,
  audit,
  jobs,
  messages,
  tickets,
} from "../server/db/schema";
import { DomainError } from "../server/errors";
import { readAttachment, reply } from "../server/operations";
import { activeTexts } from "../server/texts";
import { claimJob } from "./claim";
// The runner of a managed agent. A run answers one revision of a ticket in at most eight
// calls of the model; the model acts only through tools that this file runs, after the checks
// of the product, and the checks are made again before every call and every side effect.
// What a run may do is the project's mode (a reply is a draft under the review policy and is
// queued under direct), the grants of the agent and the stops; the model widens none of them.
const payload = z.object({
  ticketId: z.uuid(),
  agentId: z.uuid(),
  revision: z.number().int(),
  trigger: z.enum(["assignment", "message"]),
});
const leaseMs = 10 * 60 * 1000;
type Run = typeof agentRuns.$inferSelect;
interface End {
  state: RunState;
  reason: string | null;
  // The outcome may be unknown: a person has to look at the job.
  review?: boolean;
}
// A key that is the same for the same thing, in the form of a UUID that the operations ask
// for: asking again for what a run already did gives the same result and does it once.
function keyOf(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}
const replyKey = (run: Run) => keyOf(run.id, "reply");
async function principalOf(agentId: string): Promise<Principal | null> {
  const [agent] = await db().select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return null;
  return {
    id: agent.id,
    kind: "agent",
    active: true,
    owner: false,
    grants: [{ projectId: agent.projectId, actions: agent.actions }],
  };
}
// The conversation without what is private: drafts, discarded messages, system messages and
// internal notes are not part of it.
async function conversationOf(ticketId: string): Promise<AgentMessage[]> {
  const rows = await db()
    .select()
    .from(messages)
    .where(eq(messages.ticketId, ticketId))
    .orderBy(asc(messages.createdAt));
  const files = await db()
    .select({
      id: attachments.id,
      messageId: attachments.messageId,
      filename: attachments.filename,
      size: attachments.size,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(and(eq(messages.ticketId, ticketId), isNull(attachments.refusal)));
  return rows.flatMap((row) => {
    if (row.internal || row.authorType === "system") return [];
    if (row.deliveryState === "draft" || row.deliveryState === "discarded") return [];
    return [
      {
        role: row.authorType === "customer" ? ("customer" as const) : ("team" as const),
        name: row.authorName,
        at: row.createdAt,
        text: row.markdown,
        attachments: files.filter((file) => file.messageId === row.id),
      },
    ];
  });
}
// A reply that this run made before (a crash after it, a second attempt of the job) ends the
// run as it ended then, without a call of the model.
async function earlierReply(run: Run): Promise<End | null> {
  const [job] = await db()
    .select({ type: jobs.type })
    .from(jobs)
    .where(eq(jobs.dedupKey, `reply:${run.agentId}:${replyKey(run)}`));
  if (!job) return null;
  return { state: job.type === "draft.recorded" ? "draft_ready" : "sent", reason: null };
}
interface Result {
  text: string;
  end?: End;
}
// The tools. A result is what the model reads next; an `end` ends the run.
async function callTool(
  run: Run,
  principal: Principal,
  counters: { attachments: number },
  name: string,
  input: unknown,
): Promise<Result> {
  if (!isAgentTool(name)) return { text: `Unknown tool ${name}.` };
  const parsed = agentTools[name].schema.safeParse(input);
  if (!parsed.success)
    return {
      text: `Invalid input: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
    };
  const [ticket] = await db().select().from(tickets).where(eq(tickets.id, run.ticketId));
  if (!ticket)
    return {
      text: "The ticket does not exist.",
      end: { state: "cancelled", reason: "ticket_missing" },
    };
  const refuse = async (what: string): Promise<Result> => {
    await db()
      .insert(audit)
      .values({
        projectId: run.projectId,
        actorId: principal.id,
        action: "agent.refused",
        targetId: ticket.id,
        detail: { runId: run.id, tool: what },
      });
    return {
      text: `You may not do that (${what}). Write a note for the team and finish with needs_person.`,
    };
  };
  if (name === "finish") {
    const { outcome } = parsed.data as z.infer<typeof agentTools.finish.schema>;
    return outcome === "no_reply_needed"
      ? { text: "Done.", end: { state: "nothing_to_do", reason: null } }
      : { text: "Done.", end: { state: "needs_person", reason: "agent_finished" } };
  }
  if (name === "read_attachment") {
    const { attachmentId } = parsed.data as z.infer<typeof agentTools.read_attachment.schema>;
    if (!permits(principal, ticket.projectId, "ticket.read_files"))
      return refuse("read_attachment");
    const read = await db()
      .select({ id: attachments.id, messageId: attachments.messageId })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(and(eq(attachments.id, attachmentId), eq(messages.ticketId, ticket.id)));
    if (read.length === 0) return { text: "That is not an attachment of this ticket." };
    if (counters.attachments >= agentLimits.attachments)
      return { text: "No more attachments can be read in this run." };
    counters.attachments += 1;
    try {
      const file = await readAttachment(principal, attachmentId);
      return { text: JSON.stringify(file).slice(0, 30_000) };
    } catch (error) {
      if (error instanceof DomainError)
        return { text: `The attachment cannot be read (${error.code}).` };
      throw error;
    }
  }
  // The two tools that write: the checks come first, as they do for a person's reply.
  const stale = await staleReason(run.id);
  if (stale)
    return {
      text: "The ticket has changed; the run is over.",
      end: { state: "cancelled", reason: stale },
    };
  if (name === "note") {
    const { markdown } = parsed.data as z.infer<typeof agentTools.note.schema>;
    if (!permits(principal, ticket.projectId, "ticket.note")) return refuse("note");
    const [mine] = await db()
      .select({ notes: agentRuns.notes, currentRevision: agentRuns.currentRevision })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id));
    if (!mine)
      return {
        text: "The run does not exist.",
        end: { state: "cancelled", reason: "run_missing" },
      };
    // The same note again is the same note: it is not written twice, whatever the revision.
    const key = keyOf(run.id, "note", markdown);
    const [earlier] = await db()
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.dedupKey, `reply:${run.agentId}:${key}`));
    if (earlier) return { text: "Note recorded." };
    if (mine.notes >= agentLimits.notes) return { text: "No more notes in this run." };
    const made = await reply(principal, ticket.id, {
      markdown,
      internal: true,
      language: ticket.language,
      resolve: false,
      expectedRevision: mine.currentRevision,
      idempotencyKey: key,
    });
    // The note raised the revision of the ticket; the run expects the new one.
    const [after] = await db()
      .select({ revision: tickets.revision })
      .from(tickets)
      .where(eq(tickets.id, ticket.id));
    if (after && !made.duplicate)
      await db()
        .update(agentRuns)
        .set({ currentRevision: after.revision, notes: sql`${agentRuns.notes} + 1` })
        .where(eq(agentRuns.id, run.id));
    return { text: "Note recorded." };
  }
  // reply
  const { markdown, resolve } = parsed.data as z.infer<typeof agentTools.reply.schema>;
  if (!permits(principal, ticket.projectId, "ticket.reply")) return refuse("reply");
  if (resolve && !permits(principal, ticket.projectId, "ticket.resolve")) return refuse("resolve");
  const [fresh] = await db().select().from(agentRuns).where(eq(agentRuns.id, run.id));
  if (!fresh)
    return { text: "The run does not exist.", end: { state: "cancelled", reason: "run_missing" } };
  try {
    const made = await reply(principal, ticket.id, {
      markdown,
      internal: false,
      language: ticket.language,
      resolve,
      expectedRevision: fresh.currentRevision,
      idempotencyKey: replyKey(run),
    });
    await db().update(agentRuns).set({ replies: 1 }).where(eq(agentRuns.id, run.id));
    return {
      text: made.draft ? "Draft recorded for a person." : "Reply queued.",
      end: { state: made.draft ? "draft_ready" : resolve ? "resolved" : "sent", reason: null },
    };
  } catch (error) {
    if (error instanceof DomainError) {
      // The ticket moved under the run: it is over, and it says why.
      const reason = await staleReason(run.id);
      if (reason)
        return {
          text: "The ticket has changed; the run is over.",
          end: { state: "cancelled", reason },
        };
      return {
        text: `The reply was refused (${error.code}).`,
        end: { state: "failed", reason: `reply_${error.code}` },
      };
    }
    if (error instanceof ZodError) return { text: "The reply was refused (invalid_input)." };
    throw error;
  }
}
// What a failed call of the model means for the run.
function ended(outcome: Extract<AiOutcome, { ok: false }>): End {
  switch (outcome.code) {
    case "ai_not_configured":
    case "ai_disabled":
    case "ai_budget_exceeded":
      return { state: "needs_person", reason: outcome.code };
    case "ai_model_unavailable":
    case "ai_quota_exhausted":
      return { state: "failed", reason: outcome.code };
    default:
      // A refused request did nothing; one that may have been accepted is not repeated and is
      // not tried at another provider.
      return outcome.refused
        ? { state: "failed", reason: outcome.code }
        : { state: "needs_person", reason: outcome.code, review: true };
  }
}
export async function runAgents(
  scope?: { projectId: string },
  deps: AiDeps = {},
): Promise<boolean> {
  const claimed = await claimJob(runJob, leaseMs, scope);
  if (!claimed) return false;
  const { job, finish, retry } = claimed;
  const parsed = payload.safeParse(job.payload);
  const [run] = parsed.success
    ? await db().select().from(agentRuns).where(eq(agentRuns.jobId, job.id))
    : [];
  if (!run) {
    await finish(
      { status: "review", leaseUntil: null, lastErrorCode: "run_missing" },
      "run_missing",
    );
    return true;
  }
  const done = async (end: End) => {
    const wrote = await endRun(run.id, end.state, end.reason);
    if (wrote)
      await db()
        .insert(audit)
        .values({
          projectId: run.projectId,
          actorId: run.agentId,
          action: "agent.run",
          targetId: run.ticketId,
          detail: { runId: run.id, state: end.state, reason: end.reason },
        });
    await finish(
      end.state === "cancelled"
        ? { status: "cancelled", leaseUntil: null, lastErrorCode: end.reason }
        : end.review
          ? { status: "review", leaseUntil: null, lastErrorCode: end.reason }
          : { status: "succeeded", leaseUntil: null },
      end.reason ?? end.state,
    );
  };
  const stale = await staleReason(run.id);
  if (stale) {
    await done({ state: "cancelled", reason: stale });
    return true;
  }
  const principal = await principalOf(run.agentId);
  const [ticket] = await db().select().from(tickets).where(eq(tickets.id, run.ticketId));
  if (!principal || !ticket) {
    await done({ state: "cancelled", reason: "ticket_missing" });
    return true;
  }
  await db()
    .update(agentRuns)
    .set({ state: "running", startedAt: run.startedAt ?? new Date() })
    .where(eq(agentRuns.id, run.id));
  const before = await earlierReply(run);
  if (before) {
    await done(before);
    return true;
  }
  const boundary = `ticket-data-${randomUUID()}`;
  const standard = effectiveText(
    agentKey,
    ticket.language,
    await activeTexts(ticket.projectId, ticket.language),
  );
  const system = agentSystem({ standard, boundary });
  const prompt = agentPrompt({
    boundary,
    number: ticket.number,
    subject: ticket.subject,
    customer: ticket.requesterName,
    language: ticket.language,
    messages: await conversationOf(ticket.id),
  });
  const transcript: ModelMessage[] = [];
  const counters = { attachments: 0 };
  const tools = Object.fromEntries(
    Object.entries(agentTools).map(([name, { description, schema }]) => [
      name,
      { description, schema },
    ]),
  );
  for (let step = run.steps; step < agentLimits.steps; step++) {
    const reason = await staleReason(run.id);
    if (reason) {
      await done({ state: "cancelled", reason });
      return true;
    }
    await db()
      .update(agentRuns)
      .set({ steps: step + 1 })
      .where(eq(agentRuns.id, run.id));
    const outcome = await runAiTask(
      {
        projectId: run.projectId,
        task: agentKey,
        system,
        prompt,
        messages: transcript,
        tools,
        actor: { id: run.agentId, kind: "agent" },
      },
      deps,
    );
    if (!outcome.ok) {
      // A limit that the provider set and that passes may be waited for: the run goes back
      // to the queue, with the steps it has used.
      if (outcome.refused && outcome.code === "ai_rate_limited" && claimed.job.attempts < 5) {
        await db().update(agentRuns).set({ state: "queued" }).where(eq(agentRuns.id, run.id));
        await retry("ai_rate_limited");
        return true;
      }
      await done(ended(outcome));
      return true;
    }
    if (outcome.toolCalls.length === 0) {
      await done({ state: "needs_person", reason: "no_action" });
      return true;
    }
    transcript.push({
      role: "assistant",
      content: outcome.toolCalls.map((call) => ({
        type: "tool-call" as const,
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
      })),
    });
    const results: Extract<ModelMessage, { role: "tool" }>["content"] = [];
    let end: End | undefined;
    for (const call of outcome.toolCalls) {
      const result = end
        ? { text: "The run has ended." }
        : await callTool(run, principal, counters, call.name, call.input);
      if (result.end && !end) end = result.end;
      results.push({
        type: "tool-result",
        toolCallId: call.id,
        toolName: call.name,
        output: { type: "text", value: result.text },
      });
    }
    transcript.push({ role: "tool", content: results });
    if (end) {
      await done(end);
      return true;
    }
  }
  await done({ state: "needs_person", reason: "step_limit" });
  return true;
}
