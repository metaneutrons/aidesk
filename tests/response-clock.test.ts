import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { jobs, projects, tickets, webhooks } from "../src/server/db/schema";
import { scanResponseClock } from "../src/server/response-clock";
// The events of the response clock with controlled time: once per cycle, at the limits of the
// project, never after the reply that ended the cycle, and again in a new cycle.
const projectId = randomUUID();
const quickId = randomUUID();
const quiet = randomUUID();
const hour = 3_600_000;
const start = new Date("2026-03-02T08:00:00.000Z");
const at = (hours: number) => new Date(start.getTime() + hours * hour);
async function ticket(project: string, values: Partial<typeof tickets.$inferInsert> = {}) {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject: "Clock",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      pendingSince: start,
      ...values,
    })
    .returning({ id: tickets.id, number: tickets.number });
  return { id: row?.id ?? "", number: row?.number ?? null };
}
const events = async (project = projectId) =>
  (
    await db()
      .select()
      .from(jobs)
      .where(and(eq(jobs.projectId, project), eq(jobs.type, "webhook.deliver")))
  )
    .map((job) => job.payload.event as { type: string; data: Record<string, unknown> })
    .sort((a, b) => a.type.localeCompare(b.type));
const countOf = async (type: string, ticketId: string) =>
  (await events()).filter((event) => event.type === type && event.data.ticketId === ticketId)
    .length;
const reset = async () => {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
};
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Clock", slug: `clock-${projectId}`, settings: {} },
      {
        id: quickId,
        name: "Quick",
        slug: `quick-${quickId}`,
        settings: { warnHours: 1, overdueHours: 2 },
      },
      { id: quiet, name: "Quiet", slug: `quiet-${quiet}`, settings: {} },
    ]);
  await db()
    .insert(webhooks)
    .values(
      [projectId, quickId].map((project) => ({
        projectId: project,
        name: "Clock",
        url: "https://example.test/hook",
        events: ["ticket.warning", "ticket.overdue"],
        secretCiphertext: "not-a-secret",
      })),
    );
}, 60_000);
afterAll(async () => {
  for (const project of [projectId, quickId, quiet]) {
    await db().delete(jobs).where(eq(jobs.projectId, project));
    await db().delete(tickets).where(eq(tickets.projectId, project));
    await db().delete(webhooks).where(eq(webhooks.projectId, project));
    await db().delete(projects).where(eq(projects.id, project));
  }
  await sqlClient().end();
});
describe("the events of the response clock", () => {
  it("send the warning at the warning limit and the overdue event at the overdue limit, each once", async () => {
    await reset();
    const { id, number } = await ticket(projectId);
    // Just before the limit nothing is sent; at the limit the warning is.
    expect(await scanResponseClock(new Date(at(4).getTime() - 1))).toEqual({
      warned: 0,
      overdue: 0,
    });
    expect(await events()).toEqual([]);
    expect(await scanResponseClock(at(4))).toEqual({ warned: 1, overdue: 0 });
    expect(await events()).toEqual([
      {
        id: expect.any(String),
        type: "ticket.warning",
        at: expect.any(String),
        projectId,
        data: { ticketId: id, number, pendingSince: start.toISOString(), limitHours: 4 },
      },
    ]);
    // Looking again, later, or after a restart changes nothing.
    expect(await scanResponseClock(at(5))).toEqual({ warned: 0, overdue: 0 });
    expect(await scanResponseClock(at(23.99))).toEqual({ warned: 0, overdue: 0 });
    expect(await scanResponseClock(at(24))).toEqual({ warned: 0, overdue: 1 });
    expect(await scanResponseClock(at(100))).toEqual({ warned: 0, overdue: 0 });
    expect(await countOf("ticket.warning", id)).toBe(1);
    expect(await countOf("ticket.overdue", id)).toBe(1);
    expect((await events()).find((event) => event.type === "ticket.overdue")?.data).toMatchObject({
      limitHours: 24,
    });
  });
  it("send both when a ticket was found past both limits", async () => {
    await reset();
    const { id } = await ticket(projectId);
    expect(await scanResponseClock(at(50))).toEqual({ warned: 1, overdue: 1 });
    expect(await countOf("ticket.warning", id)).toBe(1);
    expect(await countOf("ticket.overdue", id)).toBe(1);
  });
  it("follow the limits of each project", async () => {
    await reset();
    await db().delete(jobs).where(eq(jobs.projectId, quickId));
    await db().delete(tickets).where(eq(tickets.projectId, quickId));
    const { id } = await ticket(quickId);
    const slow = await ticket(projectId);
    expect(await scanResponseClock(at(1))).toEqual({ warned: 1, overdue: 0 });
    expect(await scanResponseClock(at(2))).toEqual({ warned: 0, overdue: 1 });
    expect(await countOf("ticket.warning", slow.id)).toBe(0);
    const quick = await events(quickId);
    expect(quick.map((event) => [event.type, event.data.ticketId, event.data.limitHours])).toEqual([
      ["ticket.overdue", id, 2],
      ["ticket.warning", id, 1],
    ]);
  });
  it("are not sent for a ticket that has no cycle, is in junk, or belongs to a project without a webhook for them", async () => {
    await reset();
    await ticket(projectId, { pendingSince: null });
    await ticket(projectId, { junkAt: at(0) });
    await ticket(projectId, { status: "resolved", pendingSince: null });
    expect(await scanResponseClock(at(100))).toEqual({ warned: 0, overdue: 0 });
    expect(await events()).toEqual([]);
    // Without a subscriber the cycle is still counted as announced; nothing is queued.
    const silent = await ticket(quiet);
    expect(await scanResponseClock(at(100))).toEqual({ warned: 1, overdue: 1 });
    expect(await events(quiet)).toEqual([]);
    const [row] = await db().select().from(tickets).where(eq(tickets.id, silent.id));
    expect(row?.warnedFor).toEqual(start);
    await db().delete(tickets).where(eq(tickets.projectId, quiet));
  });
  it("start again in a new cycle and never follow the reply that ended one", async () => {
    await reset();
    const { id } = await ticket(projectId);
    await scanResponseClock(at(30));
    expect(await countOf("ticket.overdue", id)).toBe(1);
    // A reply that was sent ends the cycle: the clock stops, and nothing follows it.
    await db()
      .update(tickets)
      .set({ pendingSince: null, status: "waiting" })
      .where(eq(tickets.id, id));
    expect(await scanResponseClock(at(60))).toEqual({ warned: 0, overdue: 0 });
    // The customer writes again: a new cycle with its own start and its own events.
    const next = at(61);
    await db()
      .update(tickets)
      .set({ pendingSince: next, status: "open" })
      .where(eq(tickets.id, id));
    expect(await scanResponseClock(at(64.99))).toEqual({ warned: 0, overdue: 0 });
    expect(await scanResponseClock(at(65))).toEqual({ warned: 1, overdue: 0 });
    expect(await scanResponseClock(at(85))).toEqual({ warned: 0, overdue: 1 });
    expect(await countOf("ticket.warning", id)).toBe(2);
    expect(await countOf("ticket.overdue", id)).toBe(2);
  });
  it("do not follow a reply that ends the cycle while the scan is about to send", async () => {
    await reset();
    const { id } = await ticket(projectId);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The reply is being committed: the row is locked and the cycle is already over for it.
    const reply = db().transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ pendingSince: null, status: "waiting" })
        .where(eq(tickets.id, id));
      await gate;
    });
    await delay(100);
    const scanning = scanResponseClock(at(30));
    await delay(300);
    release();
    await reply;
    expect(await scanning).toEqual({ warned: 0, overdue: 0 });
    expect(await events()).toEqual([]);
  });
  it("do not send an event again for the limit that was sent when the other one is due", async () => {
    await reset();
    // The overdue event was sent for this cycle; the warning limit was lowered afterwards.
    const { id } = await ticket(projectId, { overdueFor: start });
    expect(await scanResponseClock(at(30))).toEqual({ warned: 1, overdue: 0 });
    expect(await countOf("ticket.overdue", id)).toBe(0);
  });
  it("do not follow a ticket that goes to junk while the scan is about to send, and do not count junk against the limit", async () => {
    await reset();
    const junk = await ticket(projectId, { pendingSince: at(-20), junkAt: at(-1) });
    const live = await ticket(projectId, { pendingSince: at(-10) });
    expect(await scanResponseClock(at(30), 1)).toEqual({ warned: 1, overdue: 1 });
    expect(await countOf("ticket.warning", live.id)).toBe(1);
    expect(await countOf("ticket.warning", junk.id)).toBe(0);
    const other = await ticket(projectId, { pendingSince: at(-30) });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const moving = db().transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ junkAt: at(0) })
        .where(eq(tickets.id, other.id));
      await gate;
    });
    await delay(100);
    const scanning = scanResponseClock(at(30));
    await delay(300);
    release();
    await moving;
    expect(await scanning).toEqual({ warned: 0, overdue: 0 });
    expect(await countOf("ticket.warning", other.id)).toBe(0);
  });
  it("go through the oldest tickets first and a few at a time", async () => {
    await reset();
    // Inserted newest first, so that the stored order is not the order of age.
    const newest = await ticket(projectId, { pendingSince: at(-1) });
    const newer = await ticket(projectId, { pendingSince: at(-5) });
    const old = await ticket(projectId, { pendingSince: at(-10) });
    expect(await scanResponseClock(at(30), 2)).toEqual({ warned: 2, overdue: 2 });
    expect(await countOf("ticket.warning", old.id)).toBe(1);
    expect(await countOf("ticket.warning", newer.id)).toBe(1);
    expect(await countOf("ticket.warning", newest.id)).toBe(0);
    expect(await scanResponseClock(at(30), 2)).toEqual({ warned: 1, overdue: 1 });
    expect(await countOf("ticket.warning", newest.id)).toBe(1);
  });
});
