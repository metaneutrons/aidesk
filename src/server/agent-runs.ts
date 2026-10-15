import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { permits, type Principal } from "../domain/permissions";
import type { Tx } from "./changes";
import { db } from "./db";
import { agentRuns, agents, audit, jobs, projects, tickets } from "./db/schema";
import { DomainError } from "./errors";
// The work of a managed agent on a ticket. A run answers one revision of a ticket, is
// executed by the job `agent.run` and is what a person sees and what the worker checks
// again before it acts. A run is queued when the ticket is assigned to a managed agent and
// when a customer writes on a ticket that is assigned to one; it is cancelled when what it
// was for no longer holds, and a run that has started stops at its next side effect.
export const runStates = [
  "queued",
  "running",
  "draft_ready",
  "sent",
  "resolved",
  "noted",
  "nothing_to_do",
  "cancelled",
  "failed",
  "needs_person",
] as const;
export type RunState = (typeof runStates)[number];
// The states in which a run still counts: it has not ended.
export const openStates: RunState[] = ["queued", "running"];
export const runJob = "agent.run";
export type RunTrigger = "assignment" | "message";
const dedupKey = (agent: string, ticket: string, revision: number) =>
  `agent.run:${agent}:${ticket}:${String(revision)}`;
// Queues the run for the current revision of a ticket when its assignee is a managed agent
// that may work it. Asking again for the same revision gives the same run; a run that was
// cancelled for the revision is queued again. Returns null when nothing is to be queued.
export async function queueAgentRun(
  tx: Tx,
  ticketId: string,
  trigger: RunTrigger,
): Promise<{ id: string; duplicate: boolean } | null> {
  const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, ticketId)).for("update");
  if (!ticket?.assigneeAgentId) return null;
  if (ticket.junkAt !== null || ticket.agentPausedAt !== null) return null;
  // A ticket that is resolved is not worked on by assignment alone; a customer who writes
  // reopens it first.
  if (ticket.status === "resolved") return null;
  const [agent] = await tx.select().from(agents).where(eq(agents.id, ticket.assigneeAgentId));
  if (
    !agent?.managed ||
    !agent.active ||
    agent.expiresAt <= new Date() ||
    agent.projectId !== ticket.projectId
  )
    return null;
  const key = dedupKey(agent.id, ticket.id, ticket.revision);
  const [existing] = await tx
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.agentId, agent.id),
        eq(agentRuns.ticketId, ticket.id),
        eq(agentRuns.revision, ticket.revision),
      ),
    );
  if (existing && existing.state !== "cancelled") return { id: existing.id, duplicate: true };
  if (existing) {
    // The same revision again after a cancellation: the same run and job start over.
    await tx
      .update(agentRuns)
      .set({
        state: "queued",
        reason: null,
        trigger,
        steps: 0,
        replies: 0,
        currentRevision: ticket.revision,
        startedAt: null,
        endedAt: null,
      })
      .where(eq(agentRuns.id, existing.id));
    await tx
      .update(jobs)
      .set({
        status: "queued",
        attempts: 0,
        runAfter: new Date(),
        leaseUntil: null,
        leaseToken: null,
        lastErrorCode: null,
      })
      .where(eq(jobs.dedupKey, key));
    return { id: existing.id, duplicate: false };
  }
  const [job] = await tx
    .insert(jobs)
    .values({
      projectId: ticket.projectId,
      type: runJob,
      dedupKey: key,
      payload: { ticketId: ticket.id, agentId: agent.id, revision: ticket.revision, trigger },
    })
    .returning({ id: jobs.id });
  const [run] = await tx
    .insert(agentRuns)
    .values({
      projectId: ticket.projectId,
      ticketId: ticket.id,
      agentId: agent.id,
      jobId: job?.id ?? null,
      revision: ticket.revision,
      currentRevision: ticket.revision,
      trigger,
    })
    .returning({ id: agentRuns.id });
  if (!run) throw new Error("agent_run_not_created");
  return { id: run.id, duplicate: false };
}
// Takes back the runs of a ticket that have not ended: a queued job does not run, and a run
// that has started finds its state changed and stops at its next side effect. `keepAgent`
// leaves the runs of one agent alone (the agent that the ticket was just assigned to).
export async function cancelAgentRuns(
  tx: Tx,
  ticketId: string,
  reason: string,
  options: { keepAgent?: string } = {},
): Promise<number> {
  const open = await tx
    .select({ id: agentRuns.id, jobId: agentRuns.jobId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.ticketId, ticketId),
        inArray(agentRuns.state, openStates),
        options.keepAgent ? ne(agentRuns.agentId, options.keepAgent) : undefined,
      ),
    );
  if (open.length === 0) return 0;
  await tx
    .update(agentRuns)
    .set({ state: "cancelled", reason, endedAt: new Date() })
    .where(
      inArray(
        agentRuns.id,
        open.map((run) => run.id),
      ),
    );
  const queued = open.flatMap((run) => (run.jobId ? [run.jobId] : []));
  if (queued.length > 0)
    await tx
      .update(jobs)
      .set({ status: "cancelled", leaseUntil: null, lastErrorCode: reason })
      .where(and(inArray(jobs.id, queued), inArray(jobs.status, ["queued", "retry"])));
  return open.length;
}
// A person answers a ticket that a managed agent works: that is a takeover. The runs end and
// the agent does not send for the ticket again until a person resumes it.
export async function takeOver(tx: Tx, ticketId: string): Promise<void> {
  const [ticket] = await tx
    .select({ agentId: tickets.assigneeAgentId })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  if (!ticket?.agentId) return;
  const [agent] = await tx
    .select({ managed: agents.managed })
    .from(agents)
    .where(eq(agents.id, ticket.agentId));
  if (!agent?.managed) return;
  await cancelAgentRuns(tx, ticketId, "taken_over");
  await tx.update(tickets).set({ agentPausedAt: new Date() }).where(eq(tickets.id, ticketId));
}
// A person lets the managed agent work the ticket again, from its current revision.
export async function resumeAgent(principal: Principal, ticketId: string) {
  const id = z.uuid().parse(ticketId);
  const [ticket] = await db().select().from(tickets).where(eq(tickets.id, id));
  if (!ticket || !permits(principal, ticket.projectId, "ticket.read"))
    throw new DomainError("not_found", 404);
  if (principal.kind !== "human" || !permits(principal, ticket.projectId, "ticket.assign"))
    throw new DomainError("forbidden", 403);
  if (ticket.agentPausedAt === null) throw new DomainError("conflict", 409);
  return db().transaction(async (tx) => {
    await tx.update(tickets).set({ agentPausedAt: null }).where(eq(tickets.id, ticket.id));
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "agent.resume",
      targetId: ticket.id,
    });
    const queued = await queueAgentRun(tx, ticket.id, "assignment");
    return { resumed: true, run: queued?.id ?? null };
  });
}
// The runs of every ticket of an agent, for when the agent is revoked.
export async function cancelRunsOfAgent(tx: Tx, agentId: string, reason: string): Promise<void> {
  const tickets = await tx
    .selectDistinct({ ticketId: agentRuns.ticketId })
    .from(agentRuns)
    .where(and(eq(agentRuns.agentId, agentId), inArray(agentRuns.state, openStates)));
  for (const { ticketId } of tickets) await cancelAgentRuns(tx, ticketId, reason);
}
export const runOut = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  revision: z.number().int(),
  trigger: z.string(),
  state: z.enum(runStates),
  reason: z.string().nullable(),
  steps: z.number().int(),
  replies: z.number().int(),
  startedAt: z.date().nullable(),
  endedAt: z.date().nullable(),
  createdAt: z.date(),
});
// The runs on a ticket, newest first, for a person or an agent who may read it.
export async function listAgentRuns(principal: Principal, ticketId: string) {
  const id = z.uuid().parse(ticketId);
  const [ticket] = await db()
    .select({ projectId: tickets.projectId })
    .from(tickets)
    .where(eq(tickets.id, id));
  if (!ticket || !permits(principal, ticket.projectId, "ticket.read"))
    throw new DomainError("not_found", 404);
  return db()
    .select({
      id: agentRuns.id,
      agentId: agentRuns.agentId,
      revision: agentRuns.revision,
      trigger: agentRuns.trigger,
      state: agentRuns.state,
      reason: agentRuns.reason,
      steps: agentRuns.steps,
      replies: agentRuns.replies,
      startedAt: agentRuns.startedAt,
      endedAt: agentRuns.endedAt,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.ticketId, id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(20);
}
// Why a run must not go on, or null when it may. The worker asks before it starts and again
// before every side effect: the permissions, the assignment, the stops and the revision that
// count are the current ones, not those of the time the run was queued.
export async function staleReason(runId: string): Promise<string | null> {
  const [run] = await db().select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) return "run_missing";
  if (!openStates.includes(run.state as RunState)) return run.reason ?? "run_ended";
  const [ticket] = await db().select().from(tickets).where(eq(tickets.id, run.ticketId));
  if (!ticket) return "ticket_missing";
  if (ticket.junkAt !== null) return "ticket_junk";
  if (ticket.agentPausedAt !== null) return "taken_over";
  if (ticket.assigneeAgentId !== run.agentId) return "reassigned";
  if (ticket.revision !== run.currentRevision) return "stale_revision";
  const [agent] = await db().select().from(agents).where(eq(agents.id, run.agentId));
  if (
    !agent?.managed ||
    !agent.active ||
    agent.expiresAt <= new Date() ||
    agent.projectId !== ticket.projectId
  )
    return "agent_not_active";
  const [project] = await db()
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, ticket.projectId));
  if (project?.settings.stopAutonomous === true) return "stopped";
  return null;
}
// Ends a run with a state and the reason, unless it already ended (a cancellation wins).
export async function endRun(
  runId: string,
  state: RunState,
  reason: string | null,
): Promise<boolean> {
  const [ended] = await db()
    .update(agentRuns)
    .set({ state, reason, endedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.state, openStates)))
    .returning({ id: agentRuns.id });
  return ended !== undefined;
}
