import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { agents, projects, tickets } from "../src/server/db/schema";
import { getOverview, listTickets } from "../src/server/operations";
import { clampLimit, listCeiling, listStep } from "../src/domain/paging";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const hidden = randomUUID();
const now = new Date("2026-10-13T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
const reader: Principal = {
  id: `overview-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [
    { projectId, actions: ["project.read", "ticket.read"] },
    { projectId: otherProject, actions: ["project.read", "ticket.read"] },
  ],
};
async function ticket(project: string, values: Partial<typeof tickets.$inferInsert> = {}) {
  await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject: "Overview",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      ...values,
    });
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values(
      [projectId, otherProject, hidden].map((id) => ({
        id,
        name: id.slice(0, 6),
        slug: `overview-${id}`,
      })),
    );
  // Project A: one overdue (30 h), one just under the limit (23 h), one waiting
  // with a due reminder, one resolved with a future reminder, one open, one with
  // another due reminder, one assigned to an agent, one junk that is ignored.
  await ticket(projectId, { pendingSince: hoursAgo(30) });
  await ticket(projectId, { pendingSince: hoursAgo(23) });
  await ticket(projectId, { status: "waiting", remindAt: hoursAgo(1) });
  await ticket(projectId, { status: "resolved", remindAt: new Date(now.getTime() + 3_600_000) });
  await ticket(projectId, { status: "open", pendingSince: hoursAgo(2) });
  await ticket(projectId, { remindAt: hoursAgo(5) });
  const [agent] = await db()
    .insert(agents)
    .values({
      name: "Overview agent",
      projectId,
      tokenHash: `overview-${projectId}`,
      expiresAt: new Date(now.getTime() + 86_400_000),
    })
    .returning();
  await ticket(projectId, { assigneeAgentId: agent?.id ?? null, status: "open" });
  await ticket(projectId, { junkAt: now, pendingSince: hoursAgo(90), remindAt: hoursAgo(2) });
  // Project B: more oldest-unanswered tickets than one project shows.
  for (let index = 0; index < 10; index++)
    await ticket(otherProject, { pendingSince: hoursAgo(10 + index) });
  // A project the reader has no grant for must never be counted.
  await ticket(hidden, { pendingSince: hoursAgo(100) });
});
afterAll(async () => {
  const ids = [projectId, otherProject, hidden];
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(agents).where(inArray(agents.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("overview", () => {
  it("counts over every ticket of the authorized projects and leaves junk out", async () => {
    const overview = await getOverview(reader, [], now);
    const a = overview.projects.find((entry) => entry.projectId === projectId);
    expect(a).toEqual({
      projectId,
      total: 7,
      overdue: 1,
      unassigned: 4,
      remindersDue: 2,
      waiting: 1,
    });
    const b = overview.projects.find((entry) => entry.projectId === otherProject);
    expect(b).toMatchObject({ total: 10, overdue: 0, unassigned: 10 });
    expect(overview.projects.find((entry) => entry.projectId === hidden)).toBeUndefined();
  });
  it("lists the oldest unanswered tickets per project, at most eight", async () => {
    const overview = await getOverview(reader, [], now);
    const ofB = overview.oldest.filter((entry) => entry.projectId === otherProject);
    expect(ofB).toHaveLength(8);
    expect(ofB.map((entry) => entry.pendingSince?.getTime())).toEqual(
      [...ofB.map((entry) => entry.pendingSince?.getTime() ?? 0)].sort((a, b) => a - b),
    );
    expect(overview.oldest.some((entry) => entry.junkAt !== null)).toBe(false);
    expect(overview.oldest.some((entry) => entry.projectId === hidden)).toBe(false);
    expect(overview.oldest.some((entry) => entry.pendingSince === null)).toBe(false);
  });
  it("narrows to the requested projects and refuses one without a grant", async () => {
    const only = await getOverview(reader, [projectId], now);
    expect(only.projects.map((entry) => entry.projectId)).toEqual([projectId]);
    expect(only.oldest.every((entry) => entry.projectId === projectId)).toBe(true);
    await expect(getOverview(reader, [hidden], now)).rejects.toMatchObject({ code: "not_found" });
    expect(await getOverview({ ...reader, grants: [] }, [], now)).toEqual({
      projects: [],
      oldest: [],
    });
  });
});
describe("loading the list in steps", () => {
  it("honours the requested size within the fixed bounds", async () => {
    expect(listStep).toBe(250);
    expect(listCeiling).toBe(2000);
    const all = await listTickets(reader, [projectId, otherProject]);
    expect(all).toHaveLength(17);
    expect(await listTickets(reader, [projectId, otherProject], 4)).toHaveLength(4);
    expect(await listTickets(reader, [projectId, otherProject], 0)).toHaveLength(1);
    expect(await listTickets(reader, [projectId, otherProject], Number.NaN)).toHaveLength(17);
    expect([clampLimit(500), clampLimit(5000), clampLimit(-3), clampLimit(12.9)]).toEqual([
      500,
      listCeiling,
      1,
      12,
    ]);
    expect([clampLimit(Number.NaN), clampLimit(Number.POSITIVE_INFINITY)]).toEqual([
      listStep,
      listStep,
    ]);
  });
});
