import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "../src/server/db";
import {
  agents,
  audit,
  ingress,
  jobs,
  memberships,
  messages,
  projects,
  session,
  tickets,
  user,
} from "../src/server/db/schema";
import { auth } from "../src/server/auth";
import { identify, tokenHash } from "../src/server/principal";
import {
  assertProjectOpen,
  archiveProject,
  archivedActions,
  restoreProject,
} from "../src/server/archive";
import {
  getOverview,
  getTicket,
  listJunk,
  listProjects,
  listTags,
  listTickets,
  reply,
  searchTickets,
  setTicketStatus,
} from "../src/server/operations";
import { acceptInbound } from "../src/server/inbound";
import { claimJob } from "../src/worker/claim";
import { scanResponseClock } from "../src/server/response-clock";
import { getPortalTicket, issuePortalGrant, portalReply } from "../src/server/portal";
import { DomainError } from "../src/server/errors";
import { actions, type Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectP = randomUUID();
const projectQ = randomUUID();
const userIds = {
  manager: `arch-manager-${run}`,
  plain: `arch-plain-${run}`,
  owner: `arch-owner-${run}`,
  outsider: `arch-outsider-${run}`,
};
const agentId = randomUUID();
const agentToken = `agent-token-${run}`;
const outcome = async (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof DomainError ? error.code : "other"),
  );
// A request with the session of a person, made the way a browser does it: the cookie holds the token and its signature.
async function asPerson(userId: string): Promise<Principal> {
  const context = await auth().$context;
  const started = await context.internalAdapter.createSession(userId);
  const signature = createHmac("sha256", context.secret).update(started.token).digest("base64");
  const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${started.token}.${signature}`)}`;
  return identify(new Headers({ cookie }));
}
const asAgent = () => identify(new Headers({ authorization: `Bearer ${agentToken}` }));
async function ticketOf(project: string, extra: Partial<typeof tickets.$inferInsert> = {}) {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject: "Archive",
      requesterEmail: `customer-${run}@example.test`,
      requesterName: "Customer",
      language: "en",
      ...extra,
    })
    .returning();
  if (!row) throw new Error("ticket");
  await db()
    .insert(messages)
    .values({
      ticketId: row.id,
      language: "en",
      authorType: "customer",
      authorName: "Customer",
      authorEmail: `customer-${run}@example.test`,
      markdown: "Hello",
      deliveryState: "received",
    });
  return row.id;
}
const manageActions = [...actions];
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectP, name: "Archive P", slug: `arch-p-${run}` },
      { id: projectQ, name: "Archive Q", slug: `arch-q-${run}` },
    ]);
  await db()
    .insert(user)
    .values([
      { id: userIds.manager, name: "Manager", email: `${userIds.manager}@example.test` },
      { id: userIds.plain, name: "Plain", email: `${userIds.plain}@example.test` },
      { id: userIds.owner, name: "Owner", email: `${userIds.owner}@example.test`, owner: true },
      { id: userIds.outsider, name: "Outsider", email: `${userIds.outsider}@example.test` },
    ]);
  await db()
    .insert(memberships)
    .values([
      { userId: userIds.manager, projectId: projectP, actions: manageActions },
      { userId: userIds.manager, projectId: projectQ, actions: ["project.read", "ticket.read"] },
      { userId: userIds.plain, projectId: projectP, actions: ["project.read", "ticket.read"] },
      { userId: userIds.outsider, projectId: projectQ, actions: manageActions },
    ]);
  await db()
    .insert(agents)
    .values({
      id: agentId,
      name: "Archive agent",
      projectId: projectP,
      actions: ["project.read", "ticket.read", "ticket.reply", "ticket.note", "project.manage"],
      tokenHash: tokenHash(agentToken),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
});
// Every test starts with the project open, whatever the one before it left.
afterEach(async () => {
  await db()
    .update(projects)
    .set({ archivedAt: null, archivedBy: null })
    .where(eq(projects.id, projectP));
});
afterAll(async () => {
  const ids = [projectP, projectQ];
  await db().delete(ingress).where(inArray(ingress.projectId, ids));
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(agents).where(eq(agents.id, agentId));
  await db()
    .delete(session)
    .where(inArray(session.userId, Object.values(userIds)));
  await db().delete(memberships).where(inArray(memberships.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await db()
    .delete(user)
    .where(inArray(user.id, Object.values(userIds)));
});
describe("archiving and restoring a project", () => {
  it("is for a person who manages the project: another person, a token and another project are refused", async () => {
    const manager = await asPerson(userIds.manager);
    const plain = await asPerson(userIds.plain);
    const outsider = await asPerson(userIds.outsider);
    expect(await outcome(archiveProject(plain, projectP))).toBe("not_found");
    expect(await outcome(archiveProject(outsider, projectP))).toBe("not_found");
    expect(await outcome(archiveProject(await asAgent(), projectP))).toBe("forbidden");
    expect(await outcome(archiveProject(manager, randomUUID()))).toBe("not_found");
    const [before] = await db().select().from(projects).where(eq(projects.id, projectP));
    expect(before?.archivedAt).toBeNull();
    const first = await archiveProject(manager, projectP);
    expect(first.archived).toBe(true);
    const second = await archiveProject(manager, projectP);
    expect(second.archivedAt.getTime()).toBe(first.archivedAt.getTime());
    const entries = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.projectId, projectP), eq(audit.action, "project.archive")));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorId).toBe(userIds.manager);
    await restoreProject(await asPerson(userIds.owner), projectP);
  });
  it("leaves an archived project readable and nothing else to the people and tokens in it", async () => {
    const ticket = await ticketOf(projectP);
    const manager = await asPerson(userIds.manager);
    expect(manager.grants.find((grant) => grant.projectId === projectP)?.actions).toEqual(
      manageActions,
    );
    await archiveProject(manager, projectP);
    for (const who of [await asPerson(userIds.manager), await asAgent()]) {
      const grant = who.grants.find((entry) => entry.projectId === projectP);
      expect(grant?.actions.every((action) => archivedActions.includes(action))).toBe(true);
      expect(grant?.actions).toContain("ticket.read");
      // The conversation can be read, and nothing in it can be changed or answered.
      const read = await getTicket(who, ticket);
      expect(read.ticket.id).toBe(ticket);
      const revision = read.ticket.revision;
      const refused = /^(forbidden|not_found)$/;
      for (const internal of [false, true])
        expect(
          await outcome(
            reply(who, ticket, {
              markdown: "Late answer",
              internal,
              expectedRevision: revision,
              idempotencyKey: randomUUID(),
              language: "en",
            }),
          ),
        ).toMatch(refused);
      expect(
        await outcome(
          setTicketStatus(who, ticket, { status: "resolved", expectedRevision: revision }),
        ),
      ).toMatch(refused);
    }
    // The same people keep their rights in a project that is not archived.
    const other = await asPerson(userIds.manager);
    expect(other.grants.find((grant) => grant.projectId === projectQ)?.actions).toEqual([
      "project.read",
      "ticket.read",
    ]);
    await restoreProject(await asPerson(userIds.owner), projectP);
    const back = await asPerson(userIds.manager);
    expect(back.grants.find((grant) => grant.projectId === projectP)?.actions).toEqual(
      manageActions,
    );
    expect((await asAgent()).grants[0]?.actions).toContain("ticket.reply");
    // The control: the same note that was refused while archived is accepted in the open project.
    const current = (await getTicket(back, ticket)).ticket.revision;
    expect(
      await outcome(
        reply(back, ticket, {
          markdown: "Note after the restore",
          internal: true,
          expectedRevision: current,
          idempotencyKey: randomUUID(),
          language: "en",
        }),
      ),
    ).toBe("ok");
  });
  it("is left out of the lists unless a list asks for it", async () => {
    const ticket = await ticketOf(projectP, { tags: ["archived-tag"] });
    const manager = await asPerson(userIds.manager);
    const shown = (list: { id: string }[]) => list.map((entry) => entry.id);
    expect(shown(await listProjects(manager))).toContain(projectP);
    await archiveProject(manager, projectP);
    const person = await asPerson(userIds.manager);
    expect(shown(await listProjects(person))).not.toContain(projectP);
    expect(shown(await listProjects(person, "hide"))).not.toContain(projectP);
    expect(shown(await listProjects(person, "include"))).toContain(projectP);
    expect(shown(await listProjects(person, "only"))).toEqual([projectP]);
    expect((await listProjects(person, "only"))[0]?.archivedAt).toBeInstanceOf(Date);
    expect((await listProjects(person)).every((project) => project.archivedAt === null)).toBe(true);
    // The lists of tickets do not cover it either, but a list that names it does.
    expect((await listTickets(person)).map((row) => row.id)).not.toContain(ticket);
    expect((await listTickets(person, [projectP])).map((row) => row.id)).toContain(ticket);
    expect((await getOverview(person)).projects.map((row) => row.projectId)).not.toContain(
      projectP,
    );
    expect((await getOverview(person, [projectP])).projects.map((row) => row.projectId)).toContain(
      projectP,
    );
    expect((await searchTickets(person, "Archive")).map((row) => row.id)).not.toContain(ticket);
    expect((await searchTickets(person, "Archive", [projectP])).map((row) => row.id)).toContain(
      ticket,
    );
    expect((await listTags(person)).map((row) => row.tag)).not.toContain("archived-tag");
    expect((await listTags(person, [projectP])).map((row) => row.tag)).toContain("archived-tag");
    expect(await listJunk(person)).toBeInstanceOf(Array);
    // Naming a project that the person may not read is still not found.
    expect(await outcome(listTickets(person, [randomUUID()]))).toBe("not_found");
    await restoreProject(await asPerson(userIds.owner), projectP);
    expect(shown(await listProjects(await asPerson(userIds.manager)))).toContain(projectP);
  });
  it("is restored by the owner and by a person who manages it, and by nobody else", async () => {
    await archiveProject(await asPerson(userIds.manager), projectP);
    expect(await outcome(restoreProject(await asPerson(userIds.plain), projectP))).toBe(
      "not_found",
    );
    expect(await outcome(restoreProject(await asPerson(userIds.outsider), projectP))).toBe(
      "not_found",
    );
    expect(await outcome(restoreProject(await asAgent(), projectP))).toBe("forbidden");
    // The right to manage is read from the membership, because the rights of an archived project are reduced.
    const manager = await asPerson(userIds.manager);
    expect(manager.grants.find((grant) => grant.projectId === projectP)?.actions).not.toContain(
      "project.manage",
    );
    expect((await restoreProject(manager, projectP)).archived).toBe(false);
    expect((await restoreProject(manager, projectP)).archived).toBe(false);
    await archiveProject(await asPerson(userIds.manager), projectP);
    expect((await restoreProject(await asPerson(userIds.owner), projectP)).archived).toBe(false);
    const [row] = await db().select().from(projects).where(eq(projects.id, projectP));
    expect(row).toMatchObject({ archivedAt: null, archivedBy: null });
    const entries = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.projectId, projectP), eq(audit.action, "project.restore")));
    // Both restored it, and each is in the audit with their own name.
    expect(entries.map((entry) => entry.actorId)).toEqual(
      expect.arrayContaining([userIds.manager, userIds.owner]),
    );
  });
});
describe("an archived project takes nothing in", () => {
  it("refuses a mail, and takes it again after a restore", async () => {
    const owner = await asPerson(userIds.owner);
    await archiveProject(await asPerson(userIds.manager), projectP);
    const raw = Buffer.from(
      `From: Kim <kim@example.test>\r\nTo: help@example.test\r\nSubject: Late\r\nMessage-ID: <arch-${run}@example.test>\r\n\r\nHello`,
    );
    const input = { projectId: projectP, connectionId: null, externalKey: `arch:${run}:1`, raw };
    expect(await outcome(acceptInbound(input))).toBe("project_archived");
    expect(await outcome(assertProjectOpen(projectP))).toBe("project_archived");
    expect(await db().select().from(ingress).where(eq(ingress.projectId, projectP))).toHaveLength(
      0,
    );
    await restoreProject(owner, projectP);
    expect(await outcome(assertProjectOpen(projectP))).toBe("ok");
    expect((await acceptInbound(input)).duplicate).toBe(false);
  });
  it("leaves the jobs of the project where they are until it is restored", async () => {
    const type = `archive.test.${run}`;
    await db()
      .insert(jobs)
      .values({ projectId: projectP, type, dedupKey: `${type}:1`, payload: {} });
    await db()
      .insert(jobs)
      .values({ projectId: projectQ, type, dedupKey: `${type}:2`, payload: {} });
    await archiveProject(await asPerson(userIds.manager), projectP);
    // The job of the other project is taken, and the one of the archived project is not.
    const taken = await claimJob(type, 60_000);
    expect(taken?.job.projectId).toBe(projectQ);
    await taken?.finish({ status: "succeeded" }, "test");
    expect(await claimJob(type, 60_000)).toBeNull();
    await restoreProject(await asPerson(userIds.owner), projectP);
    const later = await claimJob(type, 60_000);
    expect(later?.job.projectId).toBe(projectP);
    await later?.finish({ status: "succeeded" }, "test");
  });
  it("sends no warning for a ticket that waits in an archived project", async () => {
    const waiting = await ticketOf(projectP, {
      pendingSince: new Date(Date.now() - 10 * 3_600_000),
    });
    await archiveProject(await asPerson(userIds.manager), projectP);
    await scanResponseClock(new Date(), 500);
    const [archivedRow] = await db().select().from(tickets).where(eq(tickets.id, waiting));
    expect(archivedRow?.warnedFor).toBeNull();
    await restoreProject(await asPerson(userIds.owner), projectP);
    await scanResponseClock(new Date(), 500);
    const [openRow] = await db().select().from(tickets).where(eq(tickets.id, waiting));
    expect(openRow?.warnedFor).not.toBeNull();
  });
  it("shows the customer page read-only and takes no reply", async () => {
    const staff: Principal = {
      id: `arch-staff-${run}`,
      kind: "human",
      active: true,
      owner: false,
      grants: [{ projectId: projectP, actions: ["project.read", "ticket.read", "ticket.reply"] }],
    };
    const ticket = await ticketOf(projectP);
    const { token } = await issuePortalGrant(staff, ticket);
    expect((await getPortalTicket(token)).canReply).toBe(true);
    await archiveProject(await asPerson(userIds.manager), projectP);
    const view = await getPortalTicket(token);
    expect(view.canReply).toBe(false);
    expect(view.messages.length).toBeGreaterThan(0);
    await expect(
      portalReply(token, { markdown: "Too late", idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "project_archived", status: 409 });
    expect(
      (await db().select().from(messages).where(eq(messages.ticketId, ticket))).map(
        (row) => row.markdown,
      ),
    ).not.toContain("Too late");
    await restoreProject(await asPerson(userIds.owner), projectP);
    expect((await getPortalTicket(token)).canReply).toBe(true);
    expect(
      (await portalReply(token, { markdown: "In time", idempotencyKey: randomUUID() })).duplicate,
    ).toBe(false);
  });
});
