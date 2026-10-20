import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, jobs, projects, tickets, webhooks } from "../src/server/db/schema";
import { scanResponseClock } from "../src/server/response-clock";
import { getOverview, getTicket, listProjects, listTickets } from "../src/server/operations";
import { setTicketTriage } from "../src/server/triage";
import { configOf } from "../src/server/configuration";
import { configDocument } from "../src/domain/configuration";
import { limitsOf, priorityLimitsOf } from "../src/domain/response-clock";
import {
  categoriesOf,
  categoryIn,
  parseCategories,
  priorityOf,
  triageInput,
} from "../src/domain/triage";
import type { Principal } from "../src/domain/permissions";
const hour = 3_600_000;
const projectId = randomUUID();
const otherProject = randomUUID();
const settings = {
  categories: "Billing\nTechnical question\nFeedback",
  warnHoursUrgent: 1,
  overdueHoursUrgent: 2,
  warnHoursLow: 10,
  overdueHoursLow: 48,
};
const grant = (actions: Principal["grants"][number]["actions"]): Principal => ({
  id: `person-${randomUUID()}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions }],
});
const triager = grant(["project.read", "ticket.read", "ticket.assign"]);
const reader = grant(["project.read", "ticket.read"]);
const outsider: Principal = {
  ...triager,
  id: `outsider-${randomUUID()}`,
  grants: [{ projectId: otherProject, actions: ["ticket.read", "ticket.assign"] }],
};
// A year that no other test uses, and scans that look at this project only, so that the clock tests of other
// files, which run at the same time, neither see these tickets nor lose theirs.
const start = new Date("2040-03-05T08:00:00.000Z");
const at = (hours: number) => new Date(start.getTime() + hours * hour);
async function ticket(values: Partial<typeof tickets.$inferInsert> = {}) {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Triage",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      ...values,
    })
    .returning({ id: tickets.id });
  return row?.id ?? "";
}
const clear = async () => {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
};
const events = async (type: string) =>
  (
    await db()
      .select()
      .from(jobs)
      .where(and(eq(jobs.projectId, projectId), eq(jobs.type, "webhook.deliver")))
  )
    .map((job) => job.payload.event as { type: string; data: Record<string, unknown> })
    .filter((event) => event.type === type);
const stored = async (id: string) => {
  const [row] = await db().select().from(tickets).where(eq(tickets.id, id));
  return row;
};
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Triage", slug: `triage-${projectId}`, settings },
      { id: otherProject, name: "Other", slug: `triage-${otherProject}` },
    ]);
  await db()
    .insert(webhooks)
    .values({
      projectId,
      name: "Triage",
      url: "https://example.test/hook",
      events: ["ticket.triaged", "ticket.warning", "ticket.overdue"],
      secretCiphertext: "not-a-secret",
    });
}, 60_000);
afterAll(async () => {
  await clear();
  await db().delete(webhooks).where(eq(webhooks.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await db().delete(projects).where(eq(projects.id, otherProject));
  await sqlClient().end();
});
describe("priorities and categories as values", () => {
  it("reads a priority and falls back to normal", () => {
    expect(priorityOf("urgent")).toBe("urgent");
    for (const bad of ["", "URGENT", "critical", null, 3, undefined])
      expect(priorityOf(bad)).toBe("normal");
  });
  it("reads a list of categories, one per line", () => {
    expect(parseCategories(" Billing \n\n Technical   question\r\nFeedback ")).toEqual([
      "Billing",
      "Technical question",
      "Feedback",
    ]);
    expect(parseCategories("")).toEqual([]);
    expect(parseCategories("a, b")).toEqual(["a, b"]);
    expect(parseCategories("Billing\nbilling")).toBeNull();
    expect(parseCategories("x".repeat(41))).toBeNull();
    expect(parseCategories("x".repeat(40))).toEqual(["x".repeat(40)]);
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => `c${String(index)}`).join("\n");
    expect(parseCategories(many(50))).toHaveLength(50);
    expect(parseCategories(many(51))).toBeNull();
    expect(categoriesOf({ categories: "A\nB" })).toEqual(["A", "B"]);
    expect(categoriesOf({ categories: "A\na" })).toEqual([]);
    expect(categoriesOf({ categories: 3 })).toEqual([]);
    expect(categoriesOf({})).toEqual([]);
  });
  it("finds a name on the list in any case and spacing", () => {
    expect(categoryIn(["Technical question"], "  technical   QUESTION ")).toBe(
      "Technical question",
    );
    expect(categoryIn(["Billing"], "Billin")).toBeNull();
    expect(categoryIn([], "Billing")).toBeNull();
  });
  it("takes a priority, a category or both, and nothing else", () => {
    expect(triageInput.safeParse({ priority: "high" }).success).toBe(true);
    expect(triageInput.safeParse({ category: null }).success).toBe(true);
    expect(triageInput.safeParse({ category: " Billing ", priority: "low" }).data).toEqual({
      category: "Billing",
      priority: "low",
    });
    for (const bad of [
      {},
      { priority: "huge" },
      { category: "" },
      { category: "x".repeat(41) },
      { other: 1 },
    ])
      expect(triageInput.safeParse(bad).success).toBe(false);
  });
});
describe("setting the priority and the category of a ticket", () => {
  it("changes both, audits the change and announces it", async () => {
    await clear();
    const id = await ticket();
    expect(
      await setTicketTriage(triager, id, { priority: "urgent", category: "technical QUESTION" }),
    ).toEqual({
      priority: "urgent",
      category: "Technical question",
      changed: true,
    });
    expect(await stored(id)).toMatchObject({ priority: "urgent", category: "Technical question" });
    const entries = await db().select().from(audit).where(eq(audit.targetId, id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "ticket.triage",
      actorId: triager.id,
      detail: {
        priority: { from: "normal", to: "urgent" },
        category: { from: null, to: "Technical question" },
      },
    });
    const [event] = await events("ticket.triaged");
    expect(event?.data).toMatchObject({
      ticketId: id,
      priority: "urgent",
      category: "Technical question",
      previousPriority: "normal",
      previousCategory: null,
    });
    expect((await getTicket(reader, id)).ticket).toMatchObject({
      priority: "urgent",
      category: "Technical question",
    });
  });
  it("changes one value and leaves the other", async () => {
    await clear();
    const id = await ticket({ priority: "high", category: "Billing" });
    await setTicketTriage(triager, id, { priority: "low" });
    expect(await stored(id)).toMatchObject({ priority: "low", category: "Billing" });
    await setTicketTriage(triager, id, { category: null });
    expect(await stored(id)).toMatchObject({ priority: "low", category: null });
  });
  it("does nothing, and says so, when the values are the ones the ticket has", async () => {
    await clear();
    const id = await ticket({ priority: "high", category: "Billing" });
    expect(await setTicketTriage(triager, id, { priority: "high", category: "billing" })).toEqual({
      priority: "high",
      category: "Billing",
      changed: false,
    });
    expect(await db().select().from(audit).where(eq(audit.targetId, id))).toHaveLength(0);
    expect(await events("ticket.triaged")).toHaveLength(0);
  });
  it("refuses a category that is not on the list, and a person without the right", async () => {
    await clear();
    const id = await ticket();
    await expect(setTicketTriage(triager, id, { category: "Gossip" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      setTicketTriage(triager, id, { priority: "high", category: "Gossip" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect((await stored(id))?.priority).toBe("normal");
    await expect(setTicketTriage(reader, id, { priority: "high" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(setTicketTriage(outsider, id, { priority: "high" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(setTicketTriage(triager, id, {})).rejects.toThrow();
    await expect(
      setTicketTriage(triager, randomUUID(), { priority: "high" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    // An agent with the right may do it too.
    expect(
      await setTicketTriage({ ...triager, kind: "agent" }, id, { priority: "high" }),
    ).toMatchObject({
      changed: true,
    });
  });
  it("leaves a ticket in junk alone, and a ticket keeps a category that the list lost", async () => {
    await clear();
    const junk = await ticket({ junkAt: new Date() });
    await expect(setTicketTriage(triager, junk, { priority: "high" })).rejects.toMatchObject({
      code: "conflict",
    });
    const old = await ticket({ category: "Retired" });
    expect(await setTicketTriage(triager, old, { priority: "high" })).toMatchObject({
      category: "Retired",
      changed: true,
    });
    // It can be taken off, but not set again once it is off the list.
    await setTicketTriage(triager, old, { category: null });
    await expect(setTicketTriage(triager, old, { category: "Retired" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
  it("lists the tickets of a priority or a category", async () => {
    await clear();
    const urgent = await ticket({ priority: "urgent", category: "Billing" });
    const low = await ticket({ priority: "low" });
    const plain = await ticket();
    const ids = async (only: { priority?: string; category?: string }) =>
      (await listTickets(reader, [projectId], undefined, only)).map((row) => row.id).sort();
    expect(await ids({})).toEqual([urgent, low, plain].sort());
    expect(await ids({ priority: "urgent" })).toEqual([urgent]);
    expect(await ids({ priority: "normal" })).toEqual([plain]);
    expect(await ids({ category: "billing" })).toEqual([urgent]);
    expect(await ids({ category: "Billing", priority: "low" })).toEqual([]);
    await expect(ids({ priority: "huge" })).rejects.toThrow();
  });
});
describe("limits of the response clock by priority", () => {
  it("take the limits of the priority, and those of the project where it has none", () => {
    const base = { warnHours: 4, overdueHours: 24 };
    expect(limitsOf({})).toEqual(base);
    expect(limitsOf({}, "urgent")).toEqual(base);
    expect(limitsOf(settings, "normal")).toEqual(base);
    expect(limitsOf(settings, "urgent")).toEqual({ warnHours: 1, overdueHours: 2 });
    expect(limitsOf(settings, "low")).toEqual({ warnHours: 10, overdueHours: 48 });
    expect(limitsOf(settings, "high")).toEqual(base);
    // One value of a priority is enough; the other comes from the project, and a warning is never later.
    expect(limitsOf({ overdueHoursHigh: 2 }, "high")).toEqual({ warnHours: 2, overdueHours: 2 });
    expect(limitsOf({ warnHoursHigh: 1, overdueHours: 10 }, "high")).toEqual({
      warnHours: 1,
      overdueHours: 10,
    });
    expect(limitsOf({ warnHoursHigh: 0, overdueHoursHigh: 1000 }, "high")).toEqual(base);
    expect(limitsOf({ warnHoursUrgent: "1" }, "urgent")).toEqual(base);
    expect(priorityLimitsOf(settings).urgent).toEqual({ warnHours: 1, overdueHours: 2 });
    expect(Object.keys(priorityLimitsOf(settings))).toEqual(["low", "normal", "high", "urgent"]);
  });
  it("set the events of each ticket by its own priority", async () => {
    await clear();
    const urgent = await ticket({ priority: "urgent", pendingSince: start });
    const normal = await ticket({ pendingSince: start });
    const low = await ticket({ priority: "low", pendingSince: start });
    // After 1 hour only the urgent ticket is at its warning limit.
    expect(await scanResponseClock(at(1), 100, [projectId])).toEqual({ warned: 1, overdue: 0 });
    expect(await scanResponseClock(at(2), 100, [projectId])).toEqual({ warned: 0, overdue: 1 });
    // The normal ticket (4 and 24 hours) and the low one (10 and 48) are not at a limit before 4 and 10 hours.
    expect(await scanResponseClock(at(3.9), 100, [projectId])).toEqual({ warned: 0, overdue: 0 });
    expect(await scanResponseClock(at(4), 100, [projectId])).toEqual({ warned: 1, overdue: 0 });
    expect(await scanResponseClock(at(10), 100, [projectId])).toEqual({ warned: 1, overdue: 0 });
    // At 24 hours the normal ticket is overdue; the low one is not before 48.
    expect(await scanResponseClock(at(24), 100, [projectId])).toEqual({ warned: 0, overdue: 1 });
    expect(await scanResponseClock(at(47), 100, [projectId])).toEqual({ warned: 0, overdue: 0 });
    expect(await scanResponseClock(at(48), 100, [projectId])).toEqual({ warned: 0, overdue: 1 });
    const warned = (await events("ticket.warning")).map((event) => event.data.ticketId);
    expect(new Set(warned)).toEqual(new Set([urgent, normal, low]));
    const limits = (await events("ticket.overdue")).map((event) => [
      event.data.ticketId,
      event.data.limitHours,
    ]);
    expect(limits).toEqual(
      expect.arrayContaining([
        [urgent, 2],
        [normal, 24],
        [low, 48],
      ]),
    );
  });
  it("leave the tickets of other projects alone when a scan is limited to some", async () => {
    await clear();
    await db().delete(tickets).where(eq(tickets.projectId, otherProject));
    const mine = await ticket({ pendingSince: start });
    const [theirs] = await db()
      .insert(tickets)
      .values({
        projectId: otherProject,
        subject: "Other",
        requesterEmail: "kim@example.test",
        requesterName: "Kim",
        language: "en",
        pendingSince: start,
      })
      .returning({ id: tickets.id });
    expect(await scanResponseClock(at(100), 100, [projectId])).toEqual({ warned: 1, overdue: 1 });
    expect((await stored(mine))?.warnedFor).not.toBeNull();
    expect((await stored(theirs?.id ?? ""))?.warnedFor).toBeNull();
    expect(await scanResponseClock(at(100), 100, [otherProject])).toEqual({
      warned: 1,
      overdue: 1,
    });
    expect((await stored(theirs?.id ?? ""))?.warnedFor).not.toBeNull();
    await db().delete(tickets).where(eq(tickets.projectId, otherProject));
  });
  it("count overdue tickets of the overview by priority", async () => {
    await clear();
    await ticket({ priority: "urgent", pendingSince: start });
    await ticket({ priority: "low", pendingSince: start });
    await ticket({ pendingSince: start });
    const overdue = async (hours: number) =>
      (await getOverview(reader, [projectId], at(hours))).projects[0]?.overdue;
    expect(await overdue(1)).toBe(0);
    expect(await overdue(2)).toBe(1);
    expect(await overdue(24)).toBe(2);
    expect(await overdue(48)).toBe(3);
  });
});
describe("the configuration", () => {
  const base = configOf({ name: "N", color: "#112233", defaultLanguage: "en", settings: {} });
  it("holds the limits of the priorities and the categories, empty by default", () => {
    expect(base).toMatchObject({
      warnHoursLow: null,
      overdueHoursLow: null,
      warnHoursHigh: null,
      overdueHoursHigh: null,
      warnHoursUrgent: null,
      overdueHoursUrgent: null,
      categories: "",
    });
    expect(
      configOf({ name: "N", color: "#112233", defaultLanguage: "en", settings }),
    ).toMatchObject({
      warnHoursUrgent: 1,
      overdueHoursUrgent: 2,
      categories: "Billing\nTechnical question\nFeedback",
    });
  });
  it("refuses a warning after the overdue limit of a priority, and a bad list of categories", () => {
    const ok = (change: Record<string, unknown>) =>
      configDocument.safeParse({ ...base, ...change }).success;
    expect(ok({ warnHoursUrgent: 1, overdueHoursUrgent: 2 })).toBe(true);
    expect(ok({ warnHoursUrgent: 3, overdueHoursUrgent: 2 })).toBe(false);
    // Against the limit of the project when only one value is set: 4 hours warn, 24 overdue.
    expect(ok({ overdueHoursHigh: 3 })).toBe(false);
    expect(ok({ warnHoursLow: 25 })).toBe(false);
    expect(ok({ warnHoursLow: 24 })).toBe(true);
    expect(ok({ warnHoursLow: 0 })).toBe(false);
    expect(ok({ overdueHoursLow: 721 })).toBe(false);
    expect(ok({ categories: "A\nB" })).toBe(true);
    expect(ok({ categories: "A\na" })).toBe(false);
    expect(ok({ categories: "x".repeat(41) })).toBe(false);
  });
  it("reads a pair of limits that does not fit as no limits of its own", () => {
    const read = configOf({
      name: "N",
      color: "#112233",
      defaultLanguage: "en",
      settings: { warnHoursHigh: 9, overdueHoursHigh: 3, warnHoursLow: "x", overdueHoursLow: 100 },
    });
    expect(read).toMatchObject({
      warnHoursHigh: null,
      overdueHoursHigh: null,
      warnHoursLow: null,
      overdueHoursLow: 100,
    });
  });
  it("sends the limits and the categories of each project to the desk", async () => {
    const rows = await listProjects(reader);
    const row = rows.find((entry) => entry.id === projectId);
    expect(row?.categories).toEqual(["Billing", "Technical question", "Feedback"]);
    expect(row?.limits.urgent).toEqual({ warnHours: 1, overdueHours: 2 });
    expect(row?.limits.normal).toEqual({ warnHours: 4, overdueHours: 24 });
  });
});
