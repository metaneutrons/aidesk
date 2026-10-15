import { and, desc, eq } from "drizzle-orm";
import { aiWork, type AiWork, type StopLevel } from "../domain/agent-work";
import type { Tx } from "./changes";
import { workspaceControls } from "./controls";
import { agentRuns, agents, projects, tickets } from "./db/schema";
// The AI work on a ticket for the desk, REST and MCP: the latest run of the managed agent that
// is assigned, and the stop that holds, if any. Null when the assignee is not a managed agent.
export async function aiWorkOf(
  reader: Pick<Tx, "select">,
  ticket: typeof tickets.$inferSelect,
): Promise<AiWork | null> {
  if (!ticket.assigneeAgentId) return null;
  const [agent] = await reader.select().from(agents).where(eq(agents.id, ticket.assigneeAgentId));
  if (!agent?.managed) return null;
  const [run] = await reader
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.ticketId, ticket.id), eq(agentRuns.agentId, agent.id)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  const [project] = await reader
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, ticket.projectId));
  const stop: StopLevel | null = (await workspaceControls(reader)).stopAutonomous
    ? "workspace"
    : project?.settings.stopAutonomous === true
      ? "project"
      : ticket.agentPausedAt !== null
        ? "ticket"
        : null;
  return aiWork(run ?? null, stop);
}
