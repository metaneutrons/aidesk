import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  agentRuns,
  agents,
  audit,
  jobs,
  memberships,
  messages,
  projects,
  tickets,
  user,
  workspaceSettings,
} from "../src/server/db/schema";
import {
  assignTicket,
  createManagedAgent,
  getTicket,
  listAssignees,
} from "../src/server/operations";
import {
  setWorkspaceControls,
  setProjectAgentStop,
  stopAgentOnTicket,
} from "../src/server/agent-controls";
import { controlsKey, useControlsKey } from "../src/server/controls";
import { aiWork } from "../src/domain/agent-work";
import type { Action, Principal } from "../src/domain/permissions";
// What the desk, REST and MCP show of the assignee and of the AI work on a ticket, and whom a
// person may choose. The row of the workspace is a row of this file.
useControlsKey(`controls-view-${randomUUID()}`);
const projectId = randomUUID();
const otherProjectId = randomUUID();
const person = (held: Action[], id: string, project = projectId): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId: project, actions: held }],
});
const manager = person(
  ["project.read", "ticket.read", "ticket.assign", "agent.manage"],
  `manager-${projectId}`,
);
const reader = person(["project.read", "ticket.read"], `reader-${projectId}`);
const stranger = person(
  ["project.read", "ticket.read", "ticket.assign"],
  `s-${projectId}`,
  otherProjectId,
);
const owner: Principal = {
  id: `owner-${projectId}`,
  kind: "human",
  active: true,
  owner: true,
  grants: [],
};
const blind = `blind-${projectId}`;
const gone = `gone-${projectId}`;
let managed = "";
let external = "";
let expired = "";
let inactive = "";
async function ticket() {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "View",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      pendingSince: new Date(Date.now() - 3_600_000),
    })
    .returning({ id: tickets.id });
  const id = row?.id ?? "";
  await db().insert(messages).values({
    ticketId: id,
    authorType: "customer",
    authorName: "Kim",
    markdown: "Question",
    language: "en",
    deliveryState: "received",
  });
  return id;
}
const view = async (id: string) => {
  const { assignee, aiWork: work } = await getTicket(manager, id);
  return { assignee, work };
};
const newAgent = async (values: Partial<typeof agents.$inferInsert>) =>
  (
    await db()
      .insert(agents)
      .values({
        name: "Agent",
        projectId,
        actions: ["ticket.read"],
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        ...values,
      })
      .returning({ id: agents.id })
  )[0]?.id ?? "";
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "View", slug: `view-${projectId}`, settings: {} },
      { id: otherProjectId, name: "Other", slug: `view-o-${otherProjectId}`, settings: {} },
    ]);
  await db()
    .insert(user)
    .values(
      [manager.id, reader.id, blind, gone].map((id) => ({
        id,
        name: id === manager.id ? "Mara Manager" : id,
        email: `${id}@example.test`,
        emailVerified: true,
        active: id !== gone,
      })),
    );
  await db()
    .insert(memberships)
    .values([
      ...[manager, reader].map((who) => ({
        userId: who.id,
        projectId,
        actions: [...(who.grants[0]?.actions ?? [])],
      })),
      { userId: blind, projectId, actions: ["project.read"] },
      { userId: gone, projectId, actions: ["project.read", "ticket.read"] },
    ]);
  managed = (
    await createManagedAgent(manager, projectId, { name: "AI helper", actions: ["ticket.read"] })
  ).id;
  external = await newAgent({ name: "External" });
  expired = await newAgent({ name: "Expired", expiresAt: new Date(Date.now() - 1000) });
  inactive = await newAgent({ name: "Inactive", active: false });
}, 60_000);
afterAll(async () => {
  await db().delete(workspaceSettings).where(eq(workspaceSettings.key, controlsKey()));
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(agents).where(eq(agents.projectId, projectId));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProjectId]));
  await db()
    .delete(user)
    .where(inArray(user.id, [manager.id, reader.id, blind, gone]));
  await sqlClient().end();
});
describe("the assignee of a ticket", () => {
  it("is named, with its kind, for a person, an external agent and a managed agent", async () => {
    const id = await ticket();
    expect(await view(id)).toEqual({ assignee: null, work: null });
    await assignTicket(manager, id, { userId: manager.id, agentId: null });
    expect(await view(id)).toEqual({
      assignee: { kind: "user", id: manager.id, name: "Mara Manager", managed: false },
      work: null,
    });
    await assignTicket(manager, id, { userId: null, agentId: external });
    expect(await view(id)).toEqual({
      assignee: { kind: "agent", id: external, name: "External", managed: false },
      work: null,
    });
    await assignTicket(manager, id, { userId: null, agentId: managed });
    const seen = await view(id);
    expect(seen.assignee).toEqual({ kind: "agent", id: managed, name: "AI helper", managed: true });
    expect(seen.work).toMatchObject({ state: "queued", stoppedBy: null, reason: null });
  });
  it("is reachable only for whom may read the ticket", async () => {
    const id = await ticket();
    await expect(getTicket(stranger, id)).rejects.toMatchObject({ status: 404 });
  });
});
describe("the AI work on a ticket", () => {
  it("follows the latest run of the assigned managed agent", async () => {
    const id = await ticket();
    await assignTicket(manager, id, { userId: null, agentId: managed });
    const [run] = await db().select().from(agentRuns).where(eq(agentRuns.ticketId, id));
    const runId = run?.id ?? "";
    for (const [state, expected] of [
      ["running", "running"],
      ["draft_ready", "draft_ready"],
      ["sent", "sent"],
      ["resolved", "sent"],
      ["noted", "done"],
      ["nothing_to_do", "done"],
      ["failed", "failed"],
      ["needs_person", "needs_person"],
    ] as const) {
      await db()
        .update(agentRuns)
        .set({ state, reason: null, endedAt: new Date() })
        .where(eq(agentRuns.id, runId));
      expect((await view(id)).work).toMatchObject({ state: expected, runId });
    }
    await db()
      .update(agentRuns)
      .set({ state: "cancelled", reason: "ticket_resolved" })
      .where(eq(agentRuns.id, runId));
    expect((await view(id)).work?.state).toBe("done");
  });
  it("shows a stop at its level, and the workspace before the project before the ticket", async () => {
    const id = await ticket();
    await assignTicket(manager, id, { userId: null, agentId: managed });
    await stopAgentOnTicket(manager, id);
    expect((await view(id)).work).toMatchObject({ state: "stopped", stoppedBy: "ticket" });
    await setProjectAgentStop(manager, projectId, { stopped: true });
    expect((await view(id)).work).toMatchObject({ state: "stopped", stoppedBy: "project" });
    await setWorkspaceControls(owner, { stopAutonomous: true });
    expect((await view(id)).work).toMatchObject({ state: "stopped", stoppedBy: "workspace" });
    await setWorkspaceControls(owner, { stopAutonomous: false });
    await setProjectAgentStop(manager, projectId, { stopped: false });
    expect((await view(id)).work).toMatchObject({ state: "stopped", stoppedBy: "ticket" });
  });
  it("is shown for a managed agent that has no run yet only when a stop holds", async () => {
    const id = await ticket();
    await db().update(tickets).set({ assigneeAgentId: managed }).where(eq(tickets.id, id));
    expect((await view(id)).work).toBeNull();
    await db().update(tickets).set({ agentPausedAt: new Date() }).where(eq(tickets.id, id));
    expect((await view(id)).work).toMatchObject({ state: "stopped", runId: null, at: null });
  });
  it("is not shown for an external agent, whatever stops hold, nor from the run of another agent", async () => {
    const id = await ticket();
    await assignTicket(manager, id, { userId: null, agentId: external });
    await setProjectAgentStop(manager, projectId, { stopped: true });
    await db().update(tickets).set({ agentPausedAt: new Date() }).where(eq(tickets.id, id));
    expect((await view(id)).work).toBeNull();
    await setProjectAgentStop(manager, projectId, { stopped: false });
    // The run of the agent that had the ticket before is not the work of the one that has it now.
    const second = (
      await createManagedAgent(manager, projectId, { name: "Second", actions: ["ticket.read"] })
    ).id;
    const other = await ticket();
    await assignTicket(manager, other, { userId: null, agentId: managed });
    await db().update(tickets).set({ assigneeAgentId: second }).where(eq(tickets.id, other));
    expect((await view(other)).work).toBeNull();
  });
  it("derives each state from the run and the stop", () => {
    const run = (state: string, reason: string | null = null) => ({
      id: randomUUID(),
      state,
      reason,
      endedAt: null,
      createdAt: new Date(0),
    });
    expect(aiWork(null, null)).toBeNull();
    expect(aiWork(run("queued"), null)?.state).toBe("queued");
    for (const reason of ["stopped", "workspace_stopped", "taken_over"])
      expect(aiWork(run("cancelled", reason), null)?.state).toBe("stopped");
    expect(aiWork(run("cancelled", "reassigned"), null)?.state).toBe("done");
    expect(aiWork(run("cancelled"), null)?.state).toBe("done");
    expect(aiWork(run("sent"), "ticket")?.state).toBe("stopped");
    expect(aiWork(run("sent"), null)?.at).toEqual(new Date(0));
  });
});
describe("whom a ticket can be assigned to", () => {
  it("lists the people with access and the active agents of the project, by name", async () => {
    const id = await ticket();
    const { users, agents: held } = await listAssignees(manager, id);
    expect(users.map((entry) => entry.id).sort()).toEqual([manager.id, reader.id].sort());
    expect(held).toEqual(
      expect.arrayContaining([
        { id: managed, name: "AI helper", managed: true },
        { id: external, name: "External", managed: false },
      ]),
    );
    const ids = held.map((entry) => entry.id);
    for (const excluded of [expired, inactive]) expect(ids).not.toContain(excluded);
    expect(users.map((entry) => entry.id)).not.toContain(blind);
    expect(users.map((entry) => entry.id)).not.toContain(gone);
  });
  it("is for people who may assign and read the ticket", async () => {
    const id = await ticket();
    await expect(listAssignees(reader, id)).rejects.toMatchObject({ status: 403 });
    await expect(listAssignees(stranger, id)).rejects.toMatchObject({ status: 404 });
  });
});
