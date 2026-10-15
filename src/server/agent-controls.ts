import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { permits, type Principal } from "../domain/permissions";
import { cancelAgentRuns, queueAgentRun, openStates } from "./agent-runs";
import { db } from "./db";
import { agentRuns, audit, projects, tickets, workspaceSettings } from "./db/schema";
import { controlsKey, workspaceControls } from "./controls";
import { DomainError } from "./errors";
// The stops of autonomous work and the pause of outgoing mail, at the three levels of the
// plan: the workspace (an owner), the project and the ticket (people who may assign). They
// are the same to a run and to the worker that sends: both ask again immediately before they
// act. Only people set them; an agent never does, and no stop is lifted by a model.
const id = z.uuid();
function human(principal: Principal): void {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
}
async function projectOf(principal: Principal, projectId: string) {
  const project = id.parse(projectId);
  if (!permits(principal, project, "project.read")) throw new DomainError("not_found", 404);
  human(principal);
  if (!permits(principal, project, "ticket.assign")) throw new DomainError("forbidden", 403);
  const [row] = await db().select().from(projects).where(eq(projects.id, project));
  if (!row) throw new DomainError("not_found", 404);
  return row;
}
// What a person may see of the controls that apply to a project.
export async function getAgentControls(principal: Principal, projectId: string) {
  const project = id.parse(projectId);
  if (!permits(principal, project, "project.read")) throw new DomainError("not_found", 404);
  const [row] = await db().select().from(projects).where(eq(projects.id, project));
  if (!row) throw new DomainError("not_found", 404);
  const workspace = await workspaceControls();
  return {
    project: {
      stopAutonomous: row.settings.stopAutonomous === true,
      pauseOutgoing: row.settings.pauseOutgoing === true,
    },
    workspace,
  };
}
export const stopInput = z.object({ stopped: z.boolean() }).strict();
// Stops or lets go the managed agents of one project. A stop takes back the runs that are
// queued or running at once; lifting it queues nothing by itself: a person resumes the tickets
// (`resumeAgentsInProject`), because what was queued before the stop is out of date.
export async function setProjectAgentStop(principal: Principal, projectId: string, input: unknown) {
  const { stopped } = stopInput.parse(input);
  const project = await projectOf(principal, projectId);
  return db().transaction(async (tx) => {
    await tx
      .update(projects)
      .set({
        settings: sql`${projects.settings} || ${JSON.stringify({ stopAutonomous: stopped })}::jsonb`,
      })
      .where(eq(projects.id, project.id));
    await tx.insert(audit).values({
      projectId: project.id,
      actorId: principal.id,
      action: stopped ? "agents.stop" : "agents.unstop",
      targetId: project.id,
    });
    if (stopped) {
      const open = await tx
        .selectDistinct({ ticketId: agentRuns.ticketId })
        .from(agentRuns)
        .where(and(eq(agentRuns.projectId, project.id), inArray(agentRuns.state, openStates)));
      for (const { ticketId } of open) await cancelAgentRuns(tx, ticketId, "stopped");
    }
    return { stopped };
  });
}
// A person stops the managed agent on one ticket: it does not work it again until a person
// resumes it.
export async function stopAgentOnTicket(principal: Principal, ticketId: string) {
  const [ticket] = await db()
    .select()
    .from(tickets)
    .where(eq(tickets.id, id.parse(ticketId)));
  if (!ticket || !permits(principal, ticket.projectId, "ticket.read"))
    throw new DomainError("not_found", 404);
  human(principal);
  if (!permits(principal, ticket.projectId, "ticket.assign"))
    throw new DomainError("forbidden", 403);
  if (ticket.agentPausedAt !== null) return { stopped: true, changed: false };
  return db().transaction(async (tx) => {
    await tx.update(tickets).set({ agentPausedAt: new Date() }).where(eq(tickets.id, ticket.id));
    await cancelAgentRuns(tx, ticket.id, "stopped");
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "agent.stop_ticket",
      targetId: ticket.id,
    });
    return { stopped: true, changed: true };
  });
}
// After a stop: queues a run for every open ticket that a managed agent works and that still
// waits for an answer, at its current revision, unless the ticket is stopped itself. What a run
// did before is not repeated: the run for a revision that has one is left as it is.
export async function resumeAgentsInProject(principal: Principal, projectId: string) {
  const project = await projectOf(principal, projectId);
  if (project.settings.stopAutonomous === true) throw new DomainError("conflict", 409);
  if ((await workspaceControls()).stopAutonomous) throw new DomainError("conflict", 409);
  return db().transaction(async (tx) => {
    // Only tickets with an assignee are looked at; whether the assignee may work the ticket is
    // decided by `queueAgentRun`.
    const waiting = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.projectId, project.id),
          isNotNull(tickets.pendingSince),
          isNotNull(tickets.assigneeAgentId),
        ),
      );
    let queued = 0;
    for (const { id: ticketId } of waiting) {
      const run = await queueAgentRun(tx, ticketId, "assignment");
      if (run && !run.duplicate) queued += 1;
    }
    await tx.insert(audit).values({
      projectId: project.id,
      actorId: principal.id,
      action: "agents.resume_project",
      targetId: project.id,
      detail: { queued },
    });
    return { queued };
  });
}
export const workspaceInput = z
  .object({ stopAutonomous: z.boolean().optional(), pauseOutgoing: z.boolean().optional() })
  .strict()
  .refine((values) => values.stopAutonomous !== undefined || values.pauseOutgoing !== undefined);
// The switches of the whole installation, for an owner.
export async function setWorkspaceControls(principal: Principal, input: unknown) {
  human(principal);
  if (!principal.owner) throw new DomainError("forbidden", 403);
  const values = workspaceInput.parse(input);
  const before = await workspaceControls();
  const after = {
    stopAutonomous: values.stopAutonomous ?? before.stopAutonomous,
    pauseOutgoing: values.pauseOutgoing ?? before.pauseOutgoing,
  };
  await db().transaction(async (tx) => {
    await tx
      .insert(workspaceSettings)
      .values({ key: controlsKey(), value: after, updatedBy: principal.id })
      .onConflictDoUpdate({
        target: workspaceSettings.key,
        set: { value: after, updatedBy: principal.id, updatedAt: new Date() },
      });
    // The audit of the workspace has no project; it is kept with the first project it touches
    // only through the runs it takes back, and as a log line.
    if (after.stopAutonomous && !before.stopAutonomous) {
      const open = await tx
        .selectDistinct({ ticketId: agentRuns.ticketId })
        .from(agentRuns)
        .where(inArray(agentRuns.state, openStates));
      for (const { ticketId } of open) await cancelAgentRuns(tx, ticketId, "workspace_stopped");
    }
  });
  console.log(JSON.stringify({ event: "workspace.controls", actor: principal.id, before, after }));
  return after;
}
export async function getWorkspaceControls(principal: Principal) {
  human(principal);
  if (!principal.owner) throw new DomainError("forbidden", 403);
  return workspaceControls();
}
