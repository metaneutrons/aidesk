import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  agentRuns,
  agents,
  audit,
  connections,
  jobs,
  memberships,
  messages,
  projects,
  tickets,
  user,
} from "../src/server/db/schema";
import {
  assignTicket,
  createManagedAgent,
  getTicket,
  moveTicketToJunk,
  reply,
  revokeAgentToken,
  setTicketStatus,
} from "../src/server/operations";
import {
  cancelAgentRuns,
  endRun,
  listAgentRuns,
  queueAgentRun,
  resumeAgent,
} from "../src/server/agent-runs";
import { runAgents } from "../src/worker/agent-runs";
import type { Action, Principal } from "../src/domain/permissions";
// Managed agents: created without a token, queued when a ticket is assigned to one or a
// customer writes on its ticket, taken back when what a run was for no longer holds, and
// stopped for good by a person's takeover until the person resumes it.
const projectId = randomUUID();
const connectionId = randomUUID();
const person = (held: Action[], id: string): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: held }],
});
const manager = person(
  [
    "project.read",
    "ticket.read",
    "ticket.reply",
    "ticket.note",
    "ticket.resolve",
    "ticket.assign",
    "ticket.junk",
    "agent.manage",
  ],
  `manager-${projectId}`,
);
const assigner = person(["project.read", "ticket.read", "ticket.assign"], `assigner-${projectId}`);
const reader = person(["project.read", "ticket.read"], `reader-${projectId}`);
let managed = "";
let secondManaged = "";
let external = "";
async function ticket(values: Partial<typeof tickets.$inferInsert> = {}) {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Managed",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      pendingSince: new Date(Date.now() - 3_600_000),
      ...values,
    })
    .returning({ id: tickets.id });
  await db()
    .insert(messages)
    .values({
      ticketId: row?.id ?? "",
      authorType: "customer",
      authorName: "Kim",
      markdown: "Question",
      language: "en",
      deliveryState: "received",
    });
  return row?.id ?? "";
}
const runsOf = (ticketId: string) =>
  db()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.ticketId, ticketId))
    .orderBy(desc(agentRuns.createdAt));
const jobOf = (ticketId: string, agent: string, revision: number) =>
  db()
    .select()
    .from(jobs)
    .where(eq(jobs.dedupKey, `agent.run:${agent}:${ticketId}:${String(revision)}`))
    .then((rows) => rows[0]);
const revisionOf = async (ticketId: string) => (await getTicket(manager, ticketId)).ticket.revision;
// A customer writes: the revision rises and the run is queued, as the intake does it.
async function customerWrites(ticketId: string) {
  await db().transaction(async (tx) => {
    await tx
      .update(tickets)
      .set({ revision: (await revisionOf(ticketId)) + 1, status: "open" })
      .where(eq(tickets.id, ticketId));
    await queueAgentRun(tx, ticketId, "message");
  });
}
const drain = async () => {
  let ran = 0;
  while (await runAgents({ projectId })) ran++;
  return ran;
};
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values({
      id: projectId,
      name: "Managed",
      slug: `managed-${projectId}`,
      settings: { outboundConnectionId: connectionId },
    });
  await db()
    .insert(connections)
    .values({
      id: connectionId,
      projectId,
      kind: "smtp",
      name: "Fake",
      direction: "outbound",
      status: "ready",
      config: {
        host: "127.0.0.1",
        port: 1,
        secure: false,
        from: "s@example.test",
        developmentOnly: true,
      },
    });
  await db()
    .insert(user)
    .values(
      [manager.id, assigner.id, reader.id].map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        emailVerified: true,
      })),
    );
  await db()
    .insert(memberships)
    .values(
      [manager, assigner, reader].map((who) => ({
        userId: who.id,
        projectId,
        actions: [...(who.grants[0]?.actions ?? [])],
      })),
    );
  const created = await createManagedAgent(manager, projectId, {
    name: "Support agent",
    actions: ["ticket.read", "ticket.reply", "ticket.note"],
  });
  managed = created.id;
  secondManaged = (
    await createManagedAgent(manager, projectId, { name: "Second", actions: ["ticket.read"] })
  ).id;
  external =
    (
      await db()
        .insert(agents)
        .values({
          name: "External",
          projectId,
          actions: ["ticket.read"],
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning({ id: agents.id })
    )[0]?.id ?? "";
}, 60_000);
afterAll(async () => {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(agents).where(eq(agents.projectId, projectId));
  await db().delete(connections).where(eq(connections.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await db()
    .delete(user)
    .where(inArray(user.id, [manager.id, assigner.id, reader.id]));
  await sqlClient().end();
});
describe("creating a managed agent", () => {
  it("makes an agent that the product runs, with grants, no token and an audit entry", async () => {
    const [row] = await db().select().from(agents).where(eq(agents.id, managed));
    expect(row).toMatchObject({
      managed: true,
      active: true,
      actions: ["ticket.read", "ticket.reply", "ticket.note"],
    });
    // The hash is of a secret that was thrown away: no value that anyone holds matches it.
    expect(row?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const entries = await db().select().from(audit).where(eq(audit.targetId, managed));
    expect(entries.map((entry) => entry.action)).toEqual(["agent.create_managed"]);
  });
  it("needs agent.manage, and gives no grant that the person does not hold or that no agent may hold", async () => {
    await expect(
      createManagedAgent(reader, projectId, { name: "x", actions: ["ticket.read"] }),
    ).rejects.toMatchObject({ status: 404 });
    for (const action of ["agent.manage", "config.approve", "ticket.publish_nothing"])
      await expect(
        createManagedAgent(manager, projectId, { name: "x", actions: ["ticket.read", action] }),
      ).rejects.toMatchObject({ status: 403 });
    const narrow = person(["project.read", "ticket.read", "agent.manage"], `narrow-${projectId}`);
    await expect(
      createManagedAgent(narrow, projectId, { name: "x", actions: ["ticket.reply"] }),
    ).rejects.toMatchObject({ status: 403 });
    // An agent cannot create agents.
    const agentPrincipal: Principal = { ...manager, kind: "agent" };
    await expect(
      createManagedAgent(agentPrincipal, projectId, { name: "x", actions: ["ticket.read"] }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
describe("queueing a run", () => {
  it("is one run and one job for a ticket that is assigned to a managed agent, however often it is asked", async () => {
    const id = await ticket();
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    const revision = await revisionOf(id);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({
      agentId: managed,
      revision,
      trigger: "assignment",
      state: "queued",
    });
    expect(await jobOf(id, managed, revision)).toMatchObject({
      type: "agent.run",
      status: "queued",
      projectId,
    });
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    expect(await runsOf(id)).toHaveLength(1);
    expect(await db().select().from(jobs).where(eq(jobs.type, "agent.run"))).toSatisfy(
      (rows: { dedupKey: string }[]) =>
        rows.filter((row) => row.dedupKey.includes(`:${id}:`)).length === 1,
    );
  });
  it("is nothing for a person, an external agent, a junk ticket or a resolved one", async () => {
    const id = await ticket();
    await assignTicket(assigner, id, { userId: reader.id, agentId: null });
    await assignTicket(assigner, id, { userId: null, agentId: external });
    expect(await runsOf(id)).toEqual([]);
    const junk = await ticket({ junkAt: new Date(), assigneeAgentId: managed });
    const resolved = await ticket({ status: "resolved", assigneeAgentId: managed });
    await db().transaction(async (tx) => {
      expect(await queueAgentRun(tx, junk, "assignment")).toBeNull();
      expect(await queueAgentRun(tx, resolved, "assignment")).toBeNull();
    });
  });
  it("is queued when a customer writes on a ticket of a managed agent, for the new revision", async () => {
    const id = await ticket();
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    await customerWrites(id);
    const runs = await runsOf(id);
    expect(runs.map((run) => run.trigger).sort()).toEqual(["assignment", "message"]);
    expect(new Set(runs.map((run) => run.revision)).size).toBe(2);
    // A ticket of an external agent or of nobody gets none.
    const other = await ticket({ assigneeAgentId: external });
    await customerWrites(other);
    expect(await runsOf(other)).toEqual([]);
  });
});
describe("taking a run back", () => {
  it("cancels the queued run and its job when the ticket is reassigned, and queues the new agent's", async () => {
    const id = await ticket();
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    const revision = await revisionOf(id);
    await assignTicket(assigner, id, { userId: null, agentId: secondManaged });
    const runs = await runsOf(id);
    expect(runs.map((run) => [run.agentId, run.state, run.reason]).sort()).toEqual(
      [
        [managed, "cancelled", "reassigned"],
        [secondManaged, "queued", null],
      ].sort(),
    );
    expect(await jobOf(id, managed, revision)).toMatchObject({
      status: "cancelled",
      lastErrorCode: "reassigned",
    });
    // The same agent for the same revision again starts the same run over.
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    expect(await jobOf(id, managed, revision)).toMatchObject({ status: "queued", attempts: 0 });
    expect((await runsOf(id)).filter((run) => run.agentId === managed)).toHaveLength(1);
  });
  it.each([
    [
      "a person takes the assignment",
      (id: string) => assignTicket(assigner, id, { userId: reader.id, agentId: null }),
      "reassigned",
    ],
    [
      "the ticket is resolved",
      async (id: string) =>
        setTicketStatus(manager, id, {
          status: "resolved",
          expectedRevision: await revisionOf(id),
        }),
      "ticket_resolved",
    ],
    ["the ticket goes to junk", (id: string) => moveTicketToJunk(manager, id), "ticket_junk"],
    ["the agent is revoked", async () => revokeAgentToken(manager, revokable), "agent_revoked"],
  ])("cancels it when %s", async (_label, act, reason) => {
    const id = await ticket();
    if (reason === "agent_revoked") {
      revokable = (
        await createManagedAgent(manager, projectId, {
          name: "Revocable",
          actions: ["ticket.read"],
        })
      ).id;
      await assignTicket(assigner, id, { userId: null, agentId: revokable });
    } else await assignTicket(assigner, id, { userId: null, agentId: managed });
    await act(id);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ state: "cancelled", reason });
    expect(run?.endedAt).not.toBeNull();
  });
  it("is a takeover when a person answers, and the agent stays out until a person resumes it", async () => {
    const id = await ticket();
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    await reply(manager, id, {
      markdown: "I take this one",
      internal: false,
      expectedRevision: await revisionOf(id),
      idempotencyKey: randomUUID(),
      language: "en",
      resolve: false,
    });
    expect((await runsOf(id))[0]).toMatchObject({ state: "cancelled", reason: "taken_over" });
    const [paused] = await db().select().from(tickets).where(eq(tickets.id, id));
    expect(paused?.agentPausedAt).not.toBeNull();
    // A customer writes: nothing is queued for a ticket that was taken over.
    await customerWrites(id);
    expect((await runsOf(id)).filter((run) => run.state === "queued")).toEqual([]);
    // A person who may assign resumes it; the run is for the current revision.
    await expect(resumeAgent(reader, id)).rejects.toMatchObject({ status: 403 });
    const resumed = await resumeAgent(assigner, id);
    expect(resumed).toMatchObject({ resumed: true });
    const [again] = await runsOf(id);
    expect(again).toMatchObject({ state: "queued", revision: await revisionOf(id) });
    await expect(resumeAgent(assigner, id)).rejects.toMatchObject({ status: 409 });
  });
  it("is not a takeover when a person writes a private note or an agent answers", async () => {
    const id = await ticket();
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    await reply(manager, id, {
      markdown: "A note for the team",
      internal: true,
      expectedRevision: await revisionOf(id),
      idempotencyKey: randomUUID(),
      language: "en",
      resolve: false,
    });
    expect((await runsOf(id))[0]).toMatchObject({ state: "queued" });
    const [row] = await db().select().from(tickets).where(eq(tickets.id, id));
    expect(row?.agentPausedAt).toBeNull();
  });
});
let revokable = "";
describe("an agent answers only the tickets that are assigned to it, under the direct policy", () => {
  it("refuses a reply for a ticket of another assignee when it is made", async () => {
    await db()
      .update(projects)
      .set({ settings: { outboundConnectionId: connectionId, approvalPolicy: "direct" } })
      .where(eq(projects.id, projectId));
    const mine = await ticket({ assigneeAgentId: managed });
    const foreign = await ticket({ assigneeAgentId: secondManaged });
    const asAgent: Principal = {
      id: managed,
      kind: "agent",
      active: true,
      owner: false,
      grants: [{ projectId, actions: ["project.read", "ticket.read", "ticket.reply"] }],
    };
    const body = async (id: string) => ({
      markdown: "Answer",
      internal: false,
      expectedRevision: await revisionOf(id),
      idempotencyKey: randomUUID(),
      language: "en",
      resolve: false,
    });
    await expect(reply(asAgent, foreign, await body(foreign))).rejects.toMatchObject({
      status: 403,
    });
    expect(await reply(asAgent, mine, await body(mine))).toMatchObject({ draft: false });
    await db()
      .update(projects)
      .set({ settings: { outboundConnectionId: connectionId } })
      .where(eq(projects.id, projectId));
  });
});
describe("the worker takes a run", () => {
  it("ends a queued run that may go on as needing a person until the runner exists", async () => {
    await db().delete(jobs).where(eq(jobs.type, "agent.run"));
    const id = await ticket();
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    expect(await drain()).toBe(1);
    expect((await runsOf(id))[0]).toMatchObject({
      state: "needs_person",
      reason: "runner_not_available",
    });
    expect((await runsOf(id))[0]?.startedAt).not.toBeNull();
  });
  it("ends a run whose ticket changed after it was queued, without doing anything, and says why", async () => {
    const reasons: Record<string, (id: string) => Promise<unknown>> = {
      stale_revision: (id) => customerWrites(id),
      taken_over: (id) =>
        db().update(tickets).set({ agentPausedAt: new Date() }).where(eq(tickets.id, id)),
      reassigned: (id) =>
        db().update(tickets).set({ assigneeAgentId: secondManaged }).where(eq(tickets.id, id)),
      ticket_junk: (id) =>
        db().update(tickets).set({ junkAt: new Date() }).where(eq(tickets.id, id)),
      stopped: () =>
        db()
          .update(projects)
          .set({ settings: { outboundConnectionId: connectionId, stopAutonomous: true } })
          .where(eq(projects.id, projectId)),
      agent_not_active: () =>
        db().update(agents).set({ active: false }).where(eq(agents.id, revocable)),
    };
    let revocable = managed;
    for (const [reason, change] of Object.entries(reasons)) {
      await db().delete(jobs).where(eq(jobs.type, "agent.run"));
      await db().update(agents).set({ active: true }).where(eq(agents.id, managed));
      await db()
        .update(projects)
        .set({ settings: { outboundConnectionId: connectionId } })
        .where(eq(projects.id, projectId));
      revocable = managed;
      const id = await ticket({ assigneeAgentId: managed });
      await db().transaction(async (tx) => queueAgentRun(tx, id, "assignment"));
      await change(id);
      await drain();
      const mine = (await runsOf(id)).find(
        (run) => run.agentId === managed && run.trigger === "assignment",
      );
      expect(mine, reason).toMatchObject({ state: "cancelled", reason });
    }
    await db().update(agents).set({ active: true }).where(eq(agents.id, managed));
    await db()
      .update(projects)
      .set({ settings: { outboundConnectionId: connectionId } })
      .where(eq(projects.id, projectId));
  });
  it("lets a person read the runs of a ticket and nobody else", async () => {
    const id = await ticket();
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    expect(await listAgentRuns(reader, id)).toHaveLength(1);
    const stranger = person(["project.read"], "stranger");
    await expect(listAgentRuns(stranger, id)).rejects.toMatchObject({ status: 404 });
    await expect(listAgentRuns(reader, randomUUID())).rejects.toMatchObject({ status: 404 });
  });
});

describe("what a run that has gone on is protected from", () => {
  it("is not queued again, restarted or cancelled when the same agent is assigned again", async () => {
    const id = await ticket();
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    const [run] = await runsOf(id);
    // Asking again says that it exists.
    await db().transaction(async (tx) => {
      expect(await queueAgentRun(tx, id, "assignment")).toEqual({ id: run?.id, duplicate: true });
    });
    // A run that has started is left alone by the assignment that it was made for.
    await db()
      .update(agentRuns)
      .set({ state: "running" })
      .where(eq(agentRuns.id, run?.id ?? ""));
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    expect((await runsOf(id))[0]).toMatchObject({ id: run?.id, state: "running" });
    // A run that ended is not started over.
    await db()
      .update(agentRuns)
      .set({ state: "needs_person" })
      .where(eq(agentRuns.id, run?.id ?? ""));
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    expect((await runsOf(id))[0]).toMatchObject({ id: run?.id, state: "needs_person" });
  });
  it("is cancelled in its row while its job keeps running, so that the worker finds it and stops", async () => {
    const id = await ticket();
    await assignTicket(assigner, id, { userId: null, agentId: managed });
    const revision = await revisionOf(id);
    await db()
      .update(jobs)
      .set({ status: "running" })
      .where(eq(jobs.dedupKey, `agent.run:${managed}:${id}:${String(revision)}`));
    await db().update(agentRuns).set({ state: "running" }).where(eq(agentRuns.ticketId, id));
    await db().transaction(async (tx) => {
      expect(await cancelAgentRuns(tx, id, "stopped")).toBe(1);
    });
    expect(await jobOf(id, managed, revision)).toMatchObject({ status: "running" });
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ state: "cancelled", reason: "stopped" });
    // The end that the run would write does not undo it.
    expect(await endRun(run?.id ?? "", "sent", null)).toBe(false);
    expect((await runsOf(id))[0]).toMatchObject({ state: "cancelled", reason: "stopped" });
  });
  it("is not a takeover to answer a ticket of an external agent, and a new assignment lifts a takeover", async () => {
    const mine = await ticket({ assigneeAgentId: external });
    await reply(manager, mine, {
      markdown: "Answer",
      internal: false,
      expectedRevision: await revisionOf(mine),
      idempotencyKey: randomUUID(),
      language: "en",
      resolve: false,
    });
    expect(
      (await db().select().from(tickets).where(eq(tickets.id, mine)))[0]?.agentPausedAt,
    ).toBeNull();
    const taken = await ticket();
    await assignTicket(assigner, taken, { userId: null, agentId: managed });
    await reply(manager, taken, {
      markdown: "Mine",
      internal: false,
      expectedRevision: await revisionOf(taken),
      idempotencyKey: randomUUID(),
      language: "en",
      resolve: false,
    });
    expect(
      (await db().select().from(tickets).where(eq(tickets.id, taken)))[0]?.agentPausedAt,
    ).not.toBeNull();
    await assignTicket(assigner, taken, { userId: null, agentId: secondManaged });
    expect(
      (await db().select().from(tickets).where(eq(tickets.id, taken)))[0]?.agentPausedAt,
    ).toBeNull();
    expect((await runsOf(taken))[0]).toMatchObject({ agentId: secondManaged, state: "queued" });
  });
});
