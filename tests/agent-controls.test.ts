import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq, inArray } from "drizzle-orm";
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
import { assignTicket, createManagedAgent, getTicket } from "../src/server/operations";
import {
  getAgentControls,
  getWorkspaceControls,
  resumeAgentsInProject,
  setProjectAgentStop,
  setWorkspaceControls,
  stopAgentOnTicket,
} from "../src/server/agent-controls";
import { queueAgentRun, resumeAgent, staleReason } from "../src/server/agent-runs";
import { controlsKey, useControlsKey, workspaceControls } from "../src/server/controls";
import type { Action, Principal } from "../src/domain/permissions";
// The stops of managed agents at the three levels, and what a run and the queue do when one
// holds. The row of the workspace is a row of this file, so that the other files that run
// beside it are not stopped.
useControlsKey(`controls-test-${randomUUID()}`);
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
  `x-${projectId}`,
  otherProjectId,
);
const owner: Principal = {
  id: `owner-${projectId}`,
  kind: "human",
  active: true,
  owner: true,
  grants: [],
};
let managed = "";
async function ticket(values: Partial<typeof tickets.$inferInsert> = {}, assign = true) {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Stops",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      pendingSince: new Date(Date.now() - 3_600_000),
      ...values,
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
  if (assign) await assignTicket(manager, id, { userId: null, agentId: managed });
  return id;
}
const runsOf = (ticketId: string) =>
  db()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.ticketId, ticketId))
    .orderBy(desc(agentRuns.createdAt));
const queue = (ticketId: string) =>
  db().transaction((tx) => queueAgentRun(tx, ticketId, "message"));
async function setProjectSettings(settings: Record<string, unknown>) {
  await db().update(projects).set({ settings }).where(eq(projects.id, projectId));
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Stops", slug: `stops-${projectId}`, settings: {} },
      { id: otherProjectId, name: "Other", slug: `stops-other-${otherProjectId}`, settings: {} },
    ]);
  await db()
    .insert(user)
    .values(
      [manager.id, reader.id].map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        emailVerified: true,
      })),
    );
  await db()
    .insert(memberships)
    .values(
      [manager, reader].map((who) => ({
        userId: who.id,
        projectId,
        actions: [...(who.grants[0]?.actions ?? [])],
      })),
    );
  managed = (
    await createManagedAgent(manager, projectId, {
      name: "Support agent",
      actions: ["ticket.read"],
    })
  ).id;
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
    .where(inArray(user.id, [manager.id, reader.id]));
  await sqlClient().end();
});
describe("stopping the agents of a project", () => {
  it("takes back the open runs and queues nothing while it holds", async () => {
    const id = await ticket();
    expect((await runsOf(id))[0]?.state).toBe("queued");
    await expect(setProjectAgentStop(manager, projectId, { stopped: true })).resolves.toEqual({
      stopped: true,
    });
    expect((await runsOf(id))[0]).toMatchObject({ state: "cancelled", reason: "stopped" });
    // A new assignment and a new message of the customer queue nothing.
    const next = await ticket();
    expect(await runsOf(next)).toHaveLength(0);
    expect(await queue(id)).toBeNull();
    expect((await getAgentControls(reader, projectId)).project).toEqual({
      stopAutonomous: true,
      pauseOutgoing: false,
    });
    const entries = await db().select().from(audit).where(eq(audit.targetId, projectId));
    expect(entries.map((entry) => entry.action)).toContain("agents.stop");
    await setProjectAgentStop(manager, projectId, { stopped: false });
    expect(await runsOf(next)).toHaveLength(0);
  });
  it("does not touch the other settings of the project", async () => {
    await setProjectSettings({ approvalPolicy: "direct", pauseOutgoing: true });
    await setProjectAgentStop(manager, projectId, { stopped: true });
    const [row] = await db().select().from(projects).where(eq(projects.id, projectId));
    expect(row?.settings).toEqual({
      approvalPolicy: "direct",
      pauseOutgoing: true,
      stopAutonomous: true,
    });
    await setProjectAgentStop(manager, projectId, { stopped: false });
    await setProjectSettings({});
  });
  it("is for a person who may assign, in that project", async () => {
    await expect(setProjectAgentStop(reader, projectId, { stopped: true })).rejects.toMatchObject({
      status: 403,
    });
    await expect(setProjectAgentStop(stranger, projectId, { stopped: true })).rejects.toMatchObject(
      {
        status: 404,
      },
    );
    await expect(
      setProjectAgentStop({ ...manager, kind: "agent" }, projectId, { stopped: true }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(setProjectAgentStop(manager, projectId, { stopped: "yes" })).rejects.toThrow();
    await expect(
      setProjectAgentStop(manager, randomUUID(), { stopped: true }),
    ).rejects.toMatchObject({
      status: 404,
    });
    const [row] = await db().select().from(projects).where(eq(projects.id, projectId));
    expect(row?.settings.stopAutonomous).toBeUndefined();
  });
  it("makes a run that already runs end at its next check", async () => {
    const id = await ticket();
    const [run] = await runsOf(id);
    expect(await staleReason(run?.id ?? "")).toBeNull();
    await setProjectSettings({ stopAutonomous: true });
    // The run was not cancelled by an operation: the check alone refuses it.
    expect(await staleReason(run?.id ?? "")).toBe("stopped");
    await setProjectSettings({});
    expect(await staleReason(run?.id ?? "")).toBeNull();
  });
});
describe("resuming the agents of a project", () => {
  it("queues the tickets that wait for an answer and nothing else", async () => {
    const waiting = await ticket();
    const paused = await ticket();
    await stopAgentOnTicket(manager, paused);
    const junk = await ticket({ junkAt: new Date(), assigneeAgentId: managed }, false);
    const answered = await ticket({ pendingSince: null });
    const resolved = await ticket({ status: "resolved", assigneeAgentId: managed }, false);
    const unassigned = await ticket({}, false);
    await setProjectAgentStop(manager, projectId, { stopped: true });
    await expect(resumeAgentsInProject(manager, projectId)).rejects.toMatchObject({ status: 409 });
    await setProjectAgentStop(manager, projectId, { stopped: false });
    const result = await resumeAgentsInProject(manager, projectId);
    expect(result.queued).toBeGreaterThanOrEqual(1);
    expect((await runsOf(waiting))[0]).toMatchObject({ state: "queued" });
    for (const id of [junk, resolved, unassigned]) expect(await runsOf(id)).toHaveLength(0);
    expect((await runsOf(paused))[0]?.state).toBe("cancelled");
    // A ticket that waits for nobody is not worked on after a stop: a new message queues it.
    expect((await runsOf(answered))[0]?.state).toBe("cancelled");
    const again = await resumeAgentsInProject(manager, projectId);
    expect(again.queued).toBe(0);
    const entries = await db().select().from(audit).where(eq(audit.targetId, projectId));
    expect(entries.map((entry) => entry.action)).toContain("agents.resume_project");
  });
  it("needs the right to assign, and does not run while the workspace is stopped", async () => {
    await expect(resumeAgentsInProject(reader, projectId)).rejects.toMatchObject({ status: 403 });
    await setWorkspaceControls(owner, { stopAutonomous: true });
    await expect(resumeAgentsInProject(manager, projectId)).rejects.toMatchObject({ status: 409 });
    await setWorkspaceControls(owner, { stopAutonomous: false });
  });
});
describe("stopping the agent on one ticket", () => {
  it("cancels its runs, is repeatable, and holds until a person resumes", async () => {
    const id = await ticket();
    await expect(stopAgentOnTicket(manager, id)).resolves.toEqual({ stopped: true, changed: true });
    expect((await runsOf(id))[0]).toMatchObject({ state: "cancelled", reason: "stopped" });
    const [row] = await db().select().from(tickets).where(eq(tickets.id, id));
    expect(row?.agentPausedAt).not.toBeNull();
    await expect(stopAgentOnTicket(manager, id)).resolves.toEqual({
      stopped: true,
      changed: false,
    });
    expect(await queue(id)).toBeNull();
    const resumed = await resumeAgent(manager, id, {
      expectedRevision: (await getTicket(manager, id)).ticket.revision,
    });
    expect(resumed.resumed).toBe(true);
    expect((await runsOf(id))[0]?.state).toBe("queued");
    const entries = await db().select().from(audit).where(eq(audit.targetId, id));
    expect(entries.map((entry) => entry.action)).toContain("agent.stop_ticket");
  });
  it("is for a person who may assign and can read the ticket", async () => {
    const id = await ticket();
    await expect(stopAgentOnTicket(reader, id)).rejects.toMatchObject({ status: 403 });
    await expect(stopAgentOnTicket(stranger, id)).rejects.toMatchObject({ status: 404 });
    await expect(stopAgentOnTicket({ ...manager, kind: "agent" }, id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(stopAgentOnTicket(manager, randomUUID())).rejects.toMatchObject({ status: 404 });
    expect((await getTicket(manager, id)).ticket.id).toBe(id);
    expect((await runsOf(id))[0]?.state).toBe("queued");
  });
});
describe("the controls of the workspace", () => {
  it("are for the owner, start off, and are set one at a time", async () => {
    expect(await workspaceControls()).toEqual({ stopAutonomous: false, pauseOutgoing: false });
    await expect(setWorkspaceControls(manager, { stopAutonomous: true })).rejects.toMatchObject({
      status: 403,
    });
    await expect(getWorkspaceControls(manager)).rejects.toMatchObject({ status: 403 });
    await expect(
      setWorkspaceControls({ ...owner, kind: "agent" }, { stopAutonomous: true }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(setWorkspaceControls(owner, {})).rejects.toThrow();
    await expect(setWorkspaceControls(owner, { stopAutonomous: true, other: 1 })).rejects.toThrow();
    await expect(setWorkspaceControls(owner, { pauseOutgoing: true })).resolves.toEqual({
      stopAutonomous: false,
      pauseOutgoing: true,
    });
    await expect(setWorkspaceControls(owner, { stopAutonomous: true })).resolves.toEqual({
      stopAutonomous: true,
      pauseOutgoing: true,
    });
    expect(await getWorkspaceControls(owner)).toEqual({
      stopAutonomous: true,
      pauseOutgoing: true,
    });
    expect((await getAgentControls(reader, projectId)).workspace).toEqual({
      stopAutonomous: true,
      pauseOutgoing: true,
    });
    // Naming one switch leaves the other as it was.
    await expect(setWorkspaceControls(owner, { pauseOutgoing: false })).resolves.toEqual({
      stopAutonomous: true,
      pauseOutgoing: false,
    });
    await setWorkspaceControls(owner, { stopAutonomous: false, pauseOutgoing: false });
    expect(await workspaceControls()).toEqual({ stopAutonomous: false, pauseOutgoing: false });
  });
  it("take back the runs of every project and queue nothing while the stop holds", async () => {
    const id = await ticket();
    const [run] = await runsOf(id);
    await setWorkspaceControls(owner, { stopAutonomous: true });
    expect((await runsOf(id))[0]).toMatchObject({
      state: "cancelled",
      reason: "workspace_stopped",
    });
    expect(await staleReason(run?.id ?? "")).toBe("workspace_stopped");
    expect(await queue(id)).toBeNull();
    // Setting the same value again takes nothing back a second time.
    await setWorkspaceControls(owner, { stopAutonomous: true });
    await setWorkspaceControls(owner, { stopAutonomous: false });
    expect(await queue(id)).toMatchObject({ duplicate: false });
  });
});
