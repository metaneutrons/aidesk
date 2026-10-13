import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ZodError } from "zod";
import { db, sqlClient } from "../src/server/db";
import { agents, audit, memberships, projects, tickets, user } from "../src/server/db/schema";
import { assignTicket, getTicket, setTicketStatus } from "../src/server/operations";
import type { Action, Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const personId = `person-${projectId}`;
const idlePersonId = `idle-${projectId}`;
const outsiderId = `outsider-${projectId}`;
const grant = (name: string, held: Action[]): Principal => ({
  id: `${name}-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: held }],
});
const lead = grant("lead", ["project.read", "ticket.read", "ticket.resolve", "ticket.assign"]);
const reader = grant("reader", ["project.read", "ticket.read"]);
let ticketId = "";
let agentId = "";
let foreignAgent = "";
let expiredAgent = "";
async function fresh(values: Partial<typeof tickets.$inferInsert> = {}) {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Work",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      pendingSince: new Date(Date.now() - 3_600_000),
      ...values,
    })
    .returning({ id: tickets.id });
  return row?.id ?? "";
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Work", slug: `work-${projectId}` },
      { id: otherProject, name: "Other", slug: `work-${otherProject}` },
    ]);
  await db()
    .insert(user)
    .values(
      [personId, idlePersonId, outsiderId].map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        emailVerified: true,
        active: id !== idlePersonId,
      })),
    );
  await db()
    .insert(memberships)
    .values([
      { userId: personId, projectId, actions: ["project.read", "ticket.read"] },
      { userId: idlePersonId, projectId, actions: ["project.read", "ticket.read"] },
      { userId: outsiderId, projectId: otherProject, actions: ["project.read", "ticket.read"] },
    ]);
  const make = async (project: string, expires: number) =>
    (
      await db()
        .insert(agents)
        .values({
          name: "a",
          projectId: project,
          actions: ["ticket.read"],
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + expires),
        })
        .returning({ id: agents.id })
    )[0]?.id ?? "";
  agentId = await make(projectId, 3_600_000);
  foreignAgent = await make(otherProject, 3_600_000);
  expiredAgent = await make(projectId, -1000);
  ticketId = await fresh();
});
afterAll(async () => {
  await db()
    .delete(audit)
    .where(inArray(audit.projectId, [projectId]));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db()
    .delete(agents)
    .where(inArray(agents.projectId, [projectId, otherProject]));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProject]));
  await db()
    .delete(user)
    .where(inArray(user.id, [personId, idlePersonId, outsiderId]));
  await sqlClient().end();
});
const revision = async (id: string) => (await getTicket(lead, id)).ticket.revision;
describe("resolving and reopening", () => {
  it("resolves, ends the response obligation, raises the revision and audits it", async () => {
    const id = await fresh();
    const before = await revision(id);
    expect(
      await setTicketStatus(lead, id, { status: "resolved", expectedRevision: before }),
    ).toEqual({ status: "resolved", revision: before + 1, changed: true });
    const { ticket } = await getTicket(lead, id);
    expect(ticket).toMatchObject({ status: "resolved", pendingSince: null });
    expect(ticket.resolvedAt).toBeInstanceOf(Date);
    const [entry] = await db().select().from(audit).where(eq(audit.targetId, id));
    expect(entry).toMatchObject({
      action: "ticket.status",
      detail: { from: "open", to: "resolved" },
    });
  });
  it("reopens without starting a response obligation, and repeating changes nothing", async () => {
    const id = await fresh();
    await setTicketStatus(lead, id, { status: "resolved", expectedRevision: await revision(id) });
    const mid = await revision(id);
    expect(
      await setTicketStatus(lead, id, { status: "resolved", expectedRevision: mid }),
    ).toMatchObject({ changed: false, revision: mid });
    expect(
      await setTicketStatus(lead, id, { status: "open", expectedRevision: mid }),
    ).toMatchObject({ status: "open", changed: true });
    expect((await getTicket(lead, id)).ticket).toMatchObject({
      status: "open",
      pendingSince: null,
      resolvedAt: null,
    });
  });
  it("needs ticket.resolve, the revision that was read, and a ticket that is not in junk", async () => {
    const id = await fresh();
    const current = await revision(id);
    await expect(
      setTicketStatus(reader, id, { status: "resolved", expectedRevision: current }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      setTicketStatus(lead, id, { status: "resolved", expectedRevision: current + 5 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      setTicketStatus(lead, id, { status: "waiting", expectedRevision: current }),
    ).rejects.toBeInstanceOf(ZodError);
    const junk = await fresh({ junkAt: new Date() });
    await expect(
      setTicketStatus(lead, junk, { status: "resolved", expectedRevision: await revision(junk) }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await getTicket(lead, id)).ticket.status).toBe("open");
  });
});
describe("assigning", () => {
  it("assigns a person or an agent of the project, or nobody, and audits it", async () => {
    expect(await assignTicket(lead, ticketId, { userId: personId, agentId: null })).toEqual({
      assigneeUserId: personId,
      assigneeAgentId: null,
    });
    expect(await assignTicket(lead, ticketId, { userId: null, agentId })).toEqual({
      assigneeUserId: null,
      assigneeAgentId: agentId,
    });
    expect(await assignTicket(lead, ticketId, { userId: null, agentId: null })).toEqual({
      assigneeUserId: null,
      assigneeAgentId: null,
    });
    const entries = await db().select().from(audit).where(eq(audit.targetId, ticketId));
    expect(entries.filter((entry) => entry.action === "ticket.assign")).toHaveLength(3);
  });
  it("refuses a person without access, an inactive person, an agent of another project or an expired one", async () => {
    const pointer = async (body: unknown) => {
      const error = await assignTicket(lead, ticketId, body).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ZodError);
      return (error as ZodError).issues.map((issue) => issue.path.join("/"));
    };
    expect(await pointer({ userId: outsiderId, agentId: null })).toEqual(["userId"]);
    expect(await pointer({ userId: idlePersonId, agentId: null })).toEqual(["userId"]);
    expect(await pointer({ userId: "nobody", agentId: null })).toEqual(["userId"]);
    expect(await pointer({ userId: null, agentId: foreignAgent })).toEqual(["agentId"]);
    expect(await pointer({ userId: null, agentId: expiredAgent })).toEqual(["agentId"]);
    expect(await pointer({ userId: personId, agentId })).toEqual(["agentId"]);
    expect((await getTicket(lead, ticketId)).ticket).toMatchObject({
      assigneeUserId: null,
      assigneeAgentId: null,
    });
  });
  it("needs ticket.assign and a ticket that is not in junk", async () => {
    await expect(
      assignTicket(reader, ticketId, { userId: personId, agentId: null }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const junk = await fresh({ junkAt: new Date() });
    await expect(
      assignTicket(lead, junk, { userId: personId, agentId: null }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
