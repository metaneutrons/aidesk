import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { jobs, projects, tickets, webhooks } from "../src/server/db/schema";
import { scanResponseClock } from "../src/server/response-clock";
import { getOverview, listProjects } from "../src/server/operations";
import {
  businessMillis,
  businessSettingsOf,
  businessValuesOf,
  calendarOf,
  clockMillis,
  isDate,
  isTimeZone,
  minuteOf,
  parseDays,
  parseHolidays,
  type BusinessCalendar,
} from "../src/domain/business-hours";
import { configDocument } from "../src/domain/configuration";
import { configOf } from "../src/server/configuration";
import { responseAge, responseState } from "../src/domain/response-clock";
import type { Principal } from "../src/domain/permissions";
const hour = 3_600_000;
const berlin = {
  businessDays: "1,2,3,4,5",
  businessStart: "09:00",
  businessEnd: "17:00",
  businessTimeZone: "Europe/Berlin",
  holidays: "2026-12-25",
};
const calendar = (change: Record<string, unknown> = {}): BusinessCalendar => {
  const found = calendarOf({ ...berlin, ...change });
  if (!found) throw new Error("no calendar");
  return found;
};
const hours = (from: string, to: string, cal: BusinessCalendar = calendar()) =>
  businessMillis(new Date(from), new Date(to), cal) / hour;
describe("reading the business hours", () => {
  it("takes weekdays, times, dates and zones only in their form", () => {
    expect(parseDays("5,1, 3")).toEqual([1, 3, 5]);
    for (const bad of ["", "0", "8", "1,1", "1;2", "a", "1,2,3,4,5,6,7,1"])
      expect(parseDays(bad)).toBeNull();
    expect(minuteOf("09:30")).toBe(570);
    expect(minuteOf("24:00")).toBeNull();
    expect(minuteOf("9:00")).toBeNull();
    expect(isDate("2026-02-28")).toBe(true);
    expect(isDate("2026-02-30")).toBe(false);
    expect(isDate("26-02-28")).toBe(false);
    expect(parseHolidays("2026-12-26\n2026-12-25, 2027-01-01")).toEqual([
      "2026-12-25",
      "2026-12-26",
      "2027-01-01",
    ]);
    expect(parseHolidays("")).toEqual([]);
    expect(parseHolidays("2026-12-25,2026-12-25")).toBeNull();
    expect(parseHolidays("tomorrow")).toBeNull();
    expect(
      parseHolidays(
        Array.from({ length: 201 }, (_, index) => `${String(2000 + index)}-01-01`).join(","),
      ),
    ).toBeNull();
    expect(isTimeZone("Europe/Berlin")).toBe(true);
    expect(isTimeZone("Mars/Base")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
  it("is no calendar unless days, a zone and a window are all valid", () => {
    expect(calendarOf({})).toBeNull();
    expect(calendarOf({ ...berlin, businessDays: null })).toBeNull();
    expect(calendarOf({ ...berlin, businessTimeZone: null })).toBeNull();
    expect(calendarOf({ ...berlin, businessTimeZone: "Mars/Base" })).toBeNull();
    expect(calendarOf({ ...berlin, businessDays: "9" })).toBeNull();
    expect(calendarOf({ ...berlin, businessStart: "17:00" })).toBeNull();
    expect(calendarOf({ ...berlin, businessStart: "18:00" })).toBeNull();
    expect(calendarOf({ ...berlin, businessEnd: "later" })).toBeNull();
    expect(calendar().days).toEqual([1, 2, 3, 4, 5]);
    expect(calendar().holidays.has("2026-12-25")).toBe(true);
    // The window defaults to nine to five, and a bad list of holidays is read as none.
    const bare = calendarOf({ businessDays: "1", businessTimeZone: "UTC", holidays: "nonsense" });
    expect(bare).toMatchObject({ startMinute: 540, endMinute: 1020 });
    expect(bare?.holidays.size).toBe(0);
  });
  it("hands the settings back valid, and with the days off when they do not make business hours", () => {
    expect(businessSettingsOf({})).toEqual({
      businessDays: null,
      businessStart: "09:00",
      businessEnd: "17:00",
      businessTimeZone: null,
      holidays: "",
    });
    expect(
      businessSettingsOf({ ...berlin, businessDays: "5,1", holidays: "2026-12-26,2026-12-25" }),
    ).toEqual({
      ...berlin,
      businessDays: "1,5",
      holidays: "2026-12-25,2026-12-26",
    });
    expect(
      businessSettingsOf({ ...berlin, businessTimeZone: "Mars/Base", businessStart: "x" }),
    ).toMatchObject({
      businessDays: null,
      businessTimeZone: null,
      businessStart: "09:00",
    });
    expect(
      businessValuesOf({ ...berlin, businessDays: "5,1", holidays: "2026-12-26 2026-12-25" }),
    ).toMatchObject({
      businessDays: "1,5",
      holidays: "2026-12-25,2026-12-26",
    });
    expect(businessValuesOf({ ...berlin, businessDays: null }).businessDays).toBeNull();
  });
});
describe("counting business time", () => {
  it("counts only the hours of an open day", () => {
    // Monday 26 October 2026, Berlin is on CET (UTC+1).
    expect(hours("2026-10-26T09:00:00Z", "2026-10-26T11:00:00Z")).toBe(2);
    expect(hours("2026-10-26T00:00:00Z", "2026-10-26T23:00:00Z")).toBe(8);
    expect(hours("2026-10-26T07:59:00Z", "2026-10-26T08:00:00Z")).toBe(0);
    expect(hours("2026-10-26T15:30:00Z", "2026-10-26T16:30:00Z")).toBe(0.5);
    expect(hours("2026-10-26T16:00:00Z", "2026-10-26T20:00:00Z")).toBe(0);
    expect(hours("2026-10-26T11:00:00Z", "2026-10-26T09:00:00Z")).toBe(0);
    expect(hours("2026-10-26T11:00:00Z", "2026-10-26T11:00:00Z")).toBe(0);
  });
  it("skips the weekend, and a holiday", () => {
    // Friday 23 October 16:00 Berlin (CEST) to Monday 26 October 10:00 Berlin (CET): the DST change lies between.
    expect(hours("2026-10-23T14:00:00Z", "2026-10-26T09:00:00Z")).toBe(2);
    expect(hours("2026-10-24T00:00:00Z", "2026-10-25T23:00:00Z")).toBe(0);
    // Friday 25 December 2026 is a holiday; Thursday the 24th and Monday the 28th are not.
    expect(hours("2026-12-25T00:00:00Z", "2026-12-25T23:00:00Z")).toBe(0);
    expect(hours("2026-12-24T00:00:00Z", "2026-12-28T23:00:00Z")).toBe(16);
    expect(hours("2026-12-24T00:00:00Z", "2026-12-28T23:00:00Z", calendar({ holidays: "" }))).toBe(
      24,
    );
  });
  it("follows the clock of the zone through a change of the time", () => {
    // Sunday 25 October 2026 has 25 hours in Berlin; a window from midnight to six lasts seven.
    const night = calendar({ businessDays: "7", businessStart: "00:00", businessEnd: "06:00" });
    expect(hours("2026-10-24T22:00:00Z", "2026-10-25T05:00:00Z", night)).toBe(7);
    // The day the clocks go forward, Sunday 29 March 2026, the same window lasts five.
    expect(hours("2026-03-28T23:00:00Z", "2026-03-29T05:00:00Z", night)).toBe(5);
  });
  it("uses the zone for the day, whatever the zone is", () => {
    const losAngeles = calendar({ businessTimeZone: "America/Los_Angeles" });
    // Monday 26 October 2026 09:00 in Los Angeles (PDT, UTC-7) is 16:00 UTC.
    expect(hours("2026-10-26T16:00:00Z", "2026-10-26T19:00:00Z", losAngeles)).toBe(3);
    expect(hours("2026-10-26T00:00:00Z", "2026-10-26T15:59:00Z", losAngeles)).toBe(0);
    const kolkata = calendar({ businessTimeZone: "Asia/Kolkata" });
    // 09:00 in India (UTC+5:30) is 03:30 UTC.
    expect(hours("2026-10-26T03:30:00Z", "2026-10-26T05:30:00Z", kolkata)).toBe(2);
    expect(hours("2026-10-26T03:00:00Z", "2026-10-26T03:30:00Z", kolkata)).toBe(0);
    // The weekday is the weekday where the project is: Sunday evening in Los Angeles is already Monday in UTC.
    expect(hours("2026-10-26T01:00:00Z", "2026-10-26T04:00:00Z", losAngeles)).toBe(0);
  });
  it("finds the instant of a wall time next to a change of the time", () => {
    // On Sunday 29 March 2026 the clocks go from 01:00 to 02:00 UTC+1 → UTC+2 at 01:00 UTC. A window from 01:30
    // to 03:30 starts at 00:30 UTC (CET) and ends at 01:30 UTC (CEST): one hour of the clock, two on the wall.
    const spring = calendar({ businessDays: "7", businessStart: "01:30", businessEnd: "03:30" });
    expect(hours("2026-03-28T23:00:00Z", "2026-03-29T03:00:00Z", spring)).toBe(1);
  });
  it("stops counting after ten years, which is longer than any limit", () => {
    const years = hours("2010-01-04T00:00:00Z", "2026-10-26T00:00:00Z");
    expect(years).toBeGreaterThan(720);
    expect(years).toBeLessThan(8 * 3660);
  });
  it("is the whole time without a calendar", () => {
    const from = new Date("2026-10-23T14:00:00Z");
    const to = new Date("2026-10-26T09:00:00Z");
    expect(clockMillis(from, to, null)).toBe(to.getTime() - from.getTime());
    expect(clockMillis(to, from, null)).toBe(0);
    expect(clockMillis(from, to, calendar())).toBe(2 * hour);
    expect(responseAge({ receivedAt: from, answeredAt: null }, to, calendar())).toBe(2 * hour);
    expect(responseAge({ receivedAt: from, answeredAt: to }, to, calendar())).toBeNull();
  });
  it("sets the state of a ticket by business time", () => {
    const cycle = { receivedAt: new Date("2026-10-23T14:00:00Z"), answeredAt: null };
    const monday = new Date("2026-10-26T09:00:00Z");
    // Two business hours have passed (three days of calendar time): warning at 2, overdue at 3.
    expect(responseState(cycle, monday, 2, 3, calendar())).toBe("warning");
    expect(responseState(cycle, new Date(monday.getTime() - 1), 2, 3, calendar())).toBe("pending");
    expect(responseState(cycle, new Date(monday.getTime() + hour), 2, 3, calendar())).toBe(
      "overdue",
    );
    // Without business hours the same ticket has long been overdue.
    expect(responseState(cycle, monday, 2, 3, null)).toBe("overdue");
  });
});
describe("the configuration document", () => {
  const base = configOf({ name: "N", color: "#112233", defaultLanguage: "en", settings: {} });
  it("has no business hours by default", () => {
    expect(base).toMatchObject({
      businessDays: null,
      businessStart: "09:00",
      businessEnd: "17:00",
      businessTimeZone: null,
      holidays: "",
    });
  });
  it("accepts a complete calendar and refuses the others", () => {
    const ok = (change: Record<string, unknown>) =>
      configDocument.safeParse({ ...base, ...change }).success;
    expect(ok(berlin)).toBe(true);
    expect(ok({ holidays: "2026-12-25\n2026-12-26" })).toBe(true);
    for (const bad of [
      { ...berlin, businessDays: "" },
      { ...berlin, businessDays: "1,8" },
      { ...berlin, businessTimeZone: null },
      { ...berlin, businessTimeZone: "Mars/Base" },
      { ...berlin, businessStart: "17:00" },
      { ...berlin, businessStart: "7:00" },
      { ...berlin, businessEnd: "25:00" },
      { ...berlin, holidays: "soon" },
      { holidays: "2026-02-30" },
      { businessDays: null, businessStart: "bad" },
    ])
      expect(ok(bad)).toBe(false);
    // The window is not looked at while there are no business hours, as long as it is a time.
    expect(ok({ businessStart: "18:00", businessEnd: "08:00" })).toBe(true);
  });
  it("reads a settings document that is not valid as no business hours", () => {
    expect(
      configOf({
        name: "N",
        color: "#112233",
        defaultLanguage: "en",
        settings: { ...berlin, businessTimeZone: "Mars/Base" },
      }).businessDays,
    ).toBeNull();
  });
});
const projectId = randomUUID();
const plainId = randomUUID();
const viewer: Principal = {
  id: `viewer-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [
    { projectId, actions: ["project.read", "ticket.read"] },
    { projectId: plainId, actions: ["project.read", "ticket.read"] },
  ],
};
const friday = new Date("2026-10-23T14:00:00Z");
const monday = (h: number) => new Date(Date.parse("2026-10-26T09:00:00Z") + h * hour);
async function ticket(project: string, pendingSince: Date) {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject: "Hours",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      pendingSince,
    })
    .returning({ id: tickets.id });
  return row?.id ?? "";
}
const count = async (type: string, ticketId: string) =>
  (
    await db()
      .select()
      .from(jobs)
      .where(and(eq(jobs.projectId, projectId), eq(jobs.type, "webhook.deliver")))
  ).filter((job) => {
    const event = job.payload.event as { type: string; data: Record<string, unknown> };
    return event.type === type && event.data.ticketId === ticketId;
  }).length;
const clear = async () => {
  for (const project of [projectId, plainId]) {
    await db().delete(jobs).where(eq(jobs.projectId, project));
    await db().delete(tickets).where(eq(tickets.projectId, project));
  }
};
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      {
        id: projectId,
        name: "Hours",
        slug: `hours-${projectId}`,
        settings: { ...berlin, warnHours: 2, overdueHours: 3 },
      },
      {
        id: plainId,
        name: "Plain",
        slug: `plain-${plainId}`,
        settings: { warnHours: 2, overdueHours: 3 },
      },
    ]);
  await db()
    .insert(webhooks)
    .values({
      projectId,
      name: "Clock",
      url: "https://example.test/hook",
      events: ["ticket.warning", "ticket.overdue"],
      secretCiphertext: "not-a-secret",
    });
}, 60_000);
afterAll(async () => {
  await clear();
  await db().delete(webhooks).where(eq(webhooks.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await db().delete(projects).where(eq(projects.id, plainId));
  await sqlClient().end();
});
describe("the events of the clock in a project with business hours", () => {
  it("wait for business time: nothing over the weekend, the warning after two hours of Monday, overdue after three", async () => {
    await clear();
    const waiting = await ticket(projectId, friday);
    // Saturday night, three days before Monday ends: one business hour has passed.
    expect(await scanResponseClock(new Date("2026-10-25T20:00:00Z"))).toEqual({
      warned: 0,
      overdue: 0,
    });
    expect(await scanResponseClock(new Date(monday(0).getTime() - 1))).toEqual({
      warned: 0,
      overdue: 0,
    });
    expect(await scanResponseClock(monday(0))).toEqual({ warned: 1, overdue: 0 });
    expect(await scanResponseClock(monday(0.5))).toEqual({ warned: 0, overdue: 0 });
    expect(await scanResponseClock(monday(1))).toEqual({ warned: 0, overdue: 1 });
    expect(await scanResponseClock(monday(2))).toEqual({ warned: 0, overdue: 0 });
    expect(await count("ticket.warning", waiting)).toBe(1);
    expect(await count("ticket.overdue", waiting)).toBe(1);
  });
  it("do not let tickets that wait outside the hours crowd out one that is due", async () => {
    await clear();
    // Fifty tickets of the project with business hours came in on Saturday morning. On Monday at 10:00 they have
    // waited no business time, and they are older than the ticket of the other project, which is due.
    for (let index = 0; index < 50; index += 1)
      await ticket(projectId, new Date("2026-10-24T08:00:00Z"));
    await ticket(plainId, new Date("2026-10-24T10:00:00Z"));
    expect(await scanResponseClock(monday(0), 1)).toEqual({ warned: 1, overdue: 1 });
  });
  it("still counts every hour in a project without business hours", async () => {
    await clear();
    const plain = await ticket(plainId, friday);
    await db()
      .insert(webhooks)
      .values({
        projectId: plainId,
        name: "Clock",
        url: "https://example.test/hook",
        events: ["ticket.warning", "ticket.overdue"],
        secretCiphertext: "not-a-secret",
      });
    try {
      expect(await scanResponseClock(monday(0))).toEqual({ warned: 1, overdue: 1 });
      const sent = await db()
        .select()
        .from(jobs)
        .where(and(eq(jobs.projectId, plainId), eq(jobs.type, "webhook.deliver")));
      expect(sent).toHaveLength(2);
      expect(plain).not.toBe("");
    } finally {
      await db().delete(jobs).where(eq(jobs.projectId, plainId));
      await db().delete(webhooks).where(eq(webhooks.projectId, plainId));
    }
  });
});
describe("the overview and the project list", () => {
  it("count overdue tickets in business time, and the others in calendar time", async () => {
    await clear();
    await ticket(projectId, friday);
    await ticket(projectId, friday);
    await ticket(plainId, friday);
    await ticket(plainId, new Date(monday(0).getTime() - 2 * hour));
    const early = await getOverview(viewer, [], monday(0));
    const late = await getOverview(viewer, [], monday(1));
    const overdue = (overview: typeof early, project: string) =>
      overview.projects.find((row) => row.projectId === project)?.overdue;
    // The tickets of the project with business hours have waited two business hours at 10:00 and three at 11:00.
    expect(overdue(early, projectId)).toBe(0);
    expect(overdue(late, projectId)).toBe(2);
    // Without business hours the Friday ticket is overdue on Monday; the one of Monday morning is, an hour later.
    expect(overdue(early, plainId)).toBe(1);
    expect(overdue(late, plainId)).toBe(2);
  });
  it("send the business hours of each project to the desk", async () => {
    const rows = await listProjects(viewer);
    expect(rows.find((row) => row.id === projectId)?.clock).toEqual(berlin);
    expect(rows.find((row) => row.id === plainId)?.clock).toMatchObject({ businessDays: null });
    expect(rows.every((row) => !("settings" in row))).toBe(true);
  });
});
