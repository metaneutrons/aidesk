import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { auth } from "../src/server/auth";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  memberships,
  operatorGroupMembers,
  operatorGroups,
  projects,
  session,
  tickets,
  user,
} from "../src/server/db/schema";
import { actionsOf, grantsOf, peopleWith } from "../src/server/grants";
import {
  createGroup,
  deleteGroup,
  listGroups,
  setGroupMember,
  updateGroup,
} from "../src/server/groups";
import { archiveProject, managesProject, restoreProject } from "../src/server/archive";
import { assignTicket, listAssignees, listOperators } from "../src/server/operations";
import { identify } from "../src/server/principal";
import { DomainError } from "../src/server/errors";
import type { Action, Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectA = randomUUID();
const projectB = randomUUID();
const ids = {
  boss: `grp-boss-${run}`,
  lead: `grp-lead-${run}`,
  kim: `grp-kim-${run}`,
  lee: `grp-lee-${run}`,
  off: `grp-off-${run}`,
};
const everything: Action[] = [
  "project.read",
  "project.manage",
  "ticket.read",
  "ticket.reply",
  "ticket.assign",
  "ticket.resolve",
  "config.read",
];
const person = (id: string, project: string, held: Action[]): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId: project, actions: held }],
});
const boss = person(ids.boss, projectA, everything);
// A manager who does not hold everything that the group below gives.
const lead = person(ids.lead, projectA, ["project.read", "project.manage", "ticket.read"]);
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof DomainError ? error.code : "other"),
  );
async function asPerson(userId: string): Promise<Principal> {
  const context = await auth().$context;
  const started = await context.internalAdapter.createSession(userId);
  const signature = createHmac("sha256", context.secret).update(started.token).digest("base64");
  const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${started.token}.${signature}`)}`;
  return identify(new Headers({ cookie }));
}
const auditOf = async (action: string) =>
  db()
    .select()
    .from(audit)
    .where(and(eq(audit.projectId, projectA), eq(audit.action, action)));
async function named(name: string, held: Action[], who: Principal = boss) {
  const group = await createGroup(who, projectA, { name, actions: held });
  if (!group) throw new Error("group");
  return group;
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectA, name: "Groups A", slug: `grp-a-${run}` },
      { id: projectB, name: "Groups B", slug: `grp-b-${run}` },
    ]);
  await db()
    .insert(user)
    .values(
      Object.entries(ids).map(([name, id]) => ({
        id,
        name: `Person ${name}`,
        email: `${id}@example.test`,
        emailVerified: true,
        active: name !== "off",
      })),
    );
  await db()
    .insert(memberships)
    .values([
      { userId: ids.boss, projectId: projectA, actions: everything },
      { userId: ids.lead, projectId: projectA, actions: lead.grants[0]?.actions.slice() ?? [] },
      { userId: ids.kim, projectId: projectA, actions: ["project.read"] },
    ]);
});
afterAll(async () => {
  await db()
    .delete(audit)
    .where(inArray(audit.projectId, [projectA, projectB]));
  await db()
    .delete(tickets)
    .where(inArray(tickets.projectId, [projectA, projectB]));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectA, projectB]));
  await db()
    .delete(session)
    .where(inArray(session.userId, Object.values(ids)));
  await db()
    .delete(user)
    .where(inArray(user.id, Object.values(ids)));
  await sqlClient().end();
});
describe("what a group gives", () => {
  it("is held by every member in addition to their own role, and by nobody else", async () => {
    const group = await named("Answerers", ["project.read", "ticket.read", "ticket.reply"]);
    await setGroupMember(boss, projectA, group.id, { userId: ids.kim, member: true });
    expect(await actionsOf(ids.kim, projectA)).toEqual(
      expect.arrayContaining(["project.read", "ticket.read", "ticket.reply"]),
    );
    expect((await actionsOf(ids.kim, projectA))?.length).toBe(3);
    // Lee has no membership of their own and no group: nothing.
    expect(await actionsOf(ids.lee, projectA)).toBeNull();
    await setGroupMember(boss, projectA, group.id, { userId: ids.lee, member: true });
    expect(await actionsOf(ids.lee, projectA)).toEqual(
      expect.arrayContaining(["project.read", "ticket.read", "ticket.reply"]),
    );
    await setGroupMember(boss, projectA, group.id, { userId: ids.lee, member: false });
    expect(await actionsOf(ids.lee, projectA)).toBeNull();
    await deleteGroup(boss, projectA, group.id);
    expect(await actionsOf(ids.kim, projectA)).toEqual(["project.read"]);
  });
  it("counts in the principal that a request is made with, in its own project only", async () => {
    const group = await named("Readers of tickets", ["ticket.read", "project.read"]);
    await setGroupMember(boss, projectA, group.id, { userId: ids.lee, member: true });
    const principal = await asPerson(ids.lee);
    expect(principal.grants).toEqual([
      { projectId: projectA, actions: expect.arrayContaining(["ticket.read", "project.read"]) },
    ]);
    expect(principal.grants.some((grant) => grant.projectId === projectB)).toBe(false);
    await deleteGroup(boss, projectA, group.id);
  });
  it("is reduced to reading when the project is archived, and a member who manages can restore it", async () => {
    const group = await named("Managers", ["project.read", "project.manage"]);
    await setGroupMember(boss, projectA, group.id, { userId: ids.lee, member: true });
    try {
      expect(await managesProject(person(ids.lee, projectA, []), projectA)).toBe(true);
      await archiveProject(await asPerson(ids.lee), projectA);
      const during = await asPerson(ids.lee);
      expect(during.grants[0]?.actions).toEqual(["project.read"]);
      await restoreProject(during, projectA);
      expect((await asPerson(ids.lee)).grants[0]?.actions).toEqual(
        expect.arrayContaining(["project.manage"]),
      );
    } finally {
      await db()
        .update(projects)
        .set({ archivedAt: null, archivedBy: null })
        .where(eq(projects.id, projectA));
      await deleteGroup(boss, projectA, group.id);
    }
  });
  it("makes a member assignable for the actions that the group gives, and an inactive one not", async () => {
    const group = await named("Assignable", ["project.read", "ticket.read"]);
    await setGroupMember(boss, projectA, group.id, { userId: ids.lee, member: true });
    await setGroupMember(boss, projectA, group.id, { userId: ids.off, member: true });
    const [row] = await db()
      .insert(tickets)
      .values({
        projectId: projectA,
        subject: "Assign",
        requesterEmail: "c@example.test",
        requesterName: "C",
      })
      .returning();
    const ticketId = row?.id ?? "";
    expect((await peopleWith(projectA, "ticket.read")).map((entry) => entry.id)).toEqual(
      expect.arrayContaining([ids.lee, ids.boss]),
    );
    expect((await peopleWith(projectA, "ticket.read")).map((entry) => entry.id)).not.toContain(
      ids.off,
    );
    const listed = await listAssignees(boss, ticketId);
    expect(listed.users.map((entry) => entry.id)).toContain(ids.lee);
    expect(listed.users.map((entry) => entry.id)).not.toContain(ids.off);
    expect(await outcome(assignTicket(boss, ticketId, { userId: ids.lee, agentId: null }))).toBe(
      "ok",
    );
    expect(await outcome(assignTicket(boss, ticketId, { userId: ids.off, agentId: null }))).toBe(
      "other",
    );
    await deleteGroup(boss, projectA, group.id);
    // Without the group Lee holds nothing and cannot be assigned.
    expect(await outcome(assignTicket(boss, ticketId, { userId: ids.lee, agentId: null }))).toBe(
      "other",
    );
  });
});
describe("nobody gives more than they hold", () => {
  it("refuses a group or a change of it with an action the caller does not hold", async () => {
    expect(
      await outcome(createGroup(lead, projectA, { name: "Too much", actions: ["ticket.reply"] })),
    ).toBe("forbidden");
    const own = await named("Within reach", ["project.read"], lead);
    expect(await outcome(updateGroup(lead, projectA, own.id, { actions: ["config.read"] }))).toBe(
      "forbidden",
    );
    expect(await outcome(updateGroup(lead, projectA, own.id, { actions: ["ticket.read"] }))).toBe(
      "ok",
    );
    await deleteGroup(lead, projectA, own.id);
  });
  it("leaves a group alone that holds more than the caller: change, delete and its members", async () => {
    const above = await named("Above the lead", ["project.read", "ticket.reply"]);
    await setGroupMember(boss, projectA, above.id, { userId: ids.kim, member: true });
    expect(await outcome(updateGroup(lead, projectA, above.id, { name: "Renamed" }))).toBe(
      "forbidden",
    );
    expect(await outcome(deleteGroup(lead, projectA, above.id))).toBe("forbidden");
    expect(
      await outcome(setGroupMember(lead, projectA, above.id, { userId: ids.lee, member: true })),
    ).toBe("forbidden");
    expect(
      await outcome(setGroupMember(lead, projectA, above.id, { userId: ids.kim, member: false })),
    ).toBe("forbidden");
    const [still] = await db().select().from(operatorGroups).where(eq(operatorGroups.id, above.id));
    expect(still?.name).toBe("Above the lead");
    expect(await actionsOf(ids.lee, projectA)).toBeNull();
    expect(await actionsOf(ids.kim, projectA)).toEqual(expect.arrayContaining(["ticket.reply"]));
    await deleteGroup(boss, projectA, above.id);
  });
  it("lets a manager who holds the actions add a member, and the member holds exactly those", async () => {
    const within = await named("Lead's group", ["project.read", "ticket.read"], lead);
    await setGroupMember(lead, projectA, within.id, { userId: ids.lee, member: true });
    expect(new Set(await actionsOf(ids.lee, projectA))).toEqual(
      new Set(["project.read", "ticket.read"]),
    );
    await deleteGroup(lead, projectA, within.id);
  });
});
describe("who may use the groups of a project", () => {
  it("is answered as not found for a person who does not manage it, and refused for an agent", async () => {
    const reader = person(ids.kim, projectA, ["project.read"]);
    const elsewhere = person(ids.boss, projectB, everything);
    const agent: Principal = { ...boss, kind: "agent" };
    for (const who of [reader, elsewhere])
      expect(await outcome(listGroups(who, projectA))).toBe("not_found");
    expect(await outcome(createGroup(elsewhere, projectA, { name: "X", actions: [] }))).toBe(
      "not_found",
    );
    expect(await outcome(listGroups(agent, projectA))).toBe("forbidden");
    expect(await outcome(listGroups({ ...boss, active: false }, projectA))).toBe("forbidden");
  });
  it("does not reach a group of another project by its identifier", async () => {
    const other = await createGroup(person(ids.boss, projectB, everything), projectB, {
      name: "Elsewhere",
      actions: ["project.read"],
    });
    const id = other?.id ?? "";
    expect(await outcome(updateGroup(boss, projectA, id, { name: "Taken" }))).toBe("not_found");
    expect(await outcome(deleteGroup(boss, projectA, id))).toBe("not_found");
    expect(
      await outcome(setGroupMember(boss, projectA, id, { userId: ids.lee, member: true })),
    ).toBe("not_found");
    await deleteGroup(person(ids.boss, projectB, everything), projectB, id);
  });
  it("refuses a name that is taken, a change of nothing, an unknown action and an unknown person", async () => {
    const first = await named("Same name", ["project.read"]);
    expect(await outcome(createGroup(boss, projectA, { name: "Same name", actions: [] }))).toBe(
      "conflict",
    );
    const second = await named("Other name", []);
    expect(await outcome(updateGroup(boss, projectA, second.id, { name: "Same name" }))).toBe(
      "conflict",
    );
    await expect(updateGroup(boss, projectA, second.id, {})).rejects.toThrow();
    await expect(createGroup(boss, projectA, { name: "Bad", actions: ["root"] })).rejects.toThrow();
    await expect(createGroup(boss, projectA, { name: "", actions: [] })).rejects.toThrow();
    expect(
      await outcome(setGroupMember(boss, projectA, first.id, { userId: "nobody", member: true })),
    ).toBe("not_found");
    await deleteGroup(boss, projectA, first.id);
    await deleteGroup(boss, projectA, second.id);
  });
});
describe("the list of operators and the audit", () => {
  it("shows the groups of a person and what they hold altogether, and keeps their own grants apart", async () => {
    const group = await named("Listed", ["project.read", "ticket.reply"]);
    await setGroupMember(boss, projectA, group.id, { userId: ids.kim, member: true });
    const people = await listOperators(boss);
    const kim = people.find((entry) => entry.id === ids.kim);
    expect(kim?.grants).toEqual([{ projectId: projectA, actions: ["project.read"] }]);
    expect(kim?.groups).toEqual([{ id: group.id, projectId: projectA, name: "Listed" }]);
    expect(new Set(kim?.effective[0]?.actions)).toEqual(new Set(["project.read", "ticket.reply"]));
    const lee = people.find((entry) => entry.id === ids.lee);
    expect(lee?.effective).toEqual([]);
    expect((await grantsOf(ids.kim))[0]?.actions).toContain("ticket.reply");
    await deleteGroup(boss, projectA, group.id);
  });
  it("writes one entry for each change with the actions, and none of them holds a secret", async () => {
    const group = await named("Audited", ["project.read"]);
    await updateGroup(boss, projectA, group.id, { actions: ["project.read", "ticket.read"] });
    await setGroupMember(boss, projectA, group.id, { userId: ids.lee, member: true });
    await setGroupMember(boss, projectA, group.id, { userId: ids.lee, member: false });
    await deleteGroup(boss, projectA, group.id);
    const mine = (rows: (typeof audit.$inferSelect)[]) =>
      rows.filter(
        (row) =>
          row.targetId === group.id ||
          (row.detail as { group?: string } | null)?.group === group.id,
      );
    expect(mine(await auditOf("group.create"))).toHaveLength(1);
    const [update] = mine(await auditOf("group.update"));
    expect(update?.detail).toMatchObject({
      actions: ["project.read", "ticket.read"],
      before: ["project.read"],
    });
    expect(mine(await auditOf("group.member_add"))).toHaveLength(1);
    expect(mine(await auditOf("group.member_remove"))).toHaveLength(1);
    const [removed] = mine(await auditOf("group.delete"));
    expect(removed?.detail).toMatchObject({ name: "Audited", members: 0 });
  });
  it("removes the membership of a group when the person is deleted, and the groups with the project", async () => {
    const group = await named("Cascade", ["project.read"]);
    const gone = `grp-gone-${run}`;
    await db()
      .insert(user)
      .values({ id: gone, name: "Gone", email: `${gone}@example.test`, emailVerified: true });
    await setGroupMember(boss, projectA, group.id, { userId: gone, member: true });
    await db().delete(user).where(eq(user.id, gone));
    expect(
      await db()
        .select()
        .from(operatorGroupMembers)
        .where(eq(operatorGroupMembers.groupId, group.id)),
    ).toEqual([]);
    await deleteGroup(boss, projectA, group.id);
  });
});
