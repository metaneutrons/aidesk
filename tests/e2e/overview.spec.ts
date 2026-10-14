import { z } from "zod";
import { expect, test } from "./fixtures";
// The overview counts over all tickets on the server; the screen must show what
// the API reports and follow the project filter.
const overviewSchema = z.object({
  projects: z.array(
    z.object({
      projectId: z.string(),
      total: z.number(),
      overdue: z.number(),
      unassigned: z.number(),
      remindersDue: z.number(),
      waiting: z.number(),
    }),
  ),
  oldest: z.array(z.object({ id: z.string(), projectId: z.string() })),
});
test("shows the counts the server reports and narrows them by project", async ({
  page,
  desk,
  signIn,
}) => {
  const { alpha } = desk.projects;
  await signIn();
  const read = async (query = "") =>
    overviewSchema.parse(await (await page.request.get(`/api/v1/overview${query}`)).json());
  const sum = (
    rows: z.infer<typeof overviewSchema>["projects"],
    key: "overdue" | "unassigned" | "remindersDue" | "waiting",
  ) => rows.reduce((total, row) => total + row[key], 0);
  await page.goto("/");
  const metric = (label: string) => page.locator(".metric", { hasText: label }).locator("strong");
  // Mail jobs of earlier tests change the state of tickets after those tests ended,
  // so the page is compared with a fresh read of the same filter until both agree.
  const agree = (label: string, key: Parameters<typeof sum>[1], query = "") =>
    expect
      .poll(async () => {
        const fresh = await read(query);
        return (await metric(label).innerText()) === String(sum(fresh.projects, key));
      })
      .toBe(true);
  await agree("Overdue", "overdue");
  await agree("Unassigned", "unassigned");
  await agree("Reminders due", "remindersDue");
  await agree("Waiting", "waiting");
  // One project only: the counts follow the filter and are those of the API.
  const one = await read(`?project=${alpha.id}`);
  expect(one.projects.map((row) => row.projectId)).toEqual([alpha.id]);
  expect(one.oldest.every((ticket) => ticket.projectId === alpha.id)).toBe(true);
  await page.getByRole("button", { name: "All projects" }).click();
  await page.getByRole("checkbox", { name: alpha.name }).check();
  await agree("Unassigned", "unassigned", `?project=${alpha.id}`);
  await agree("Waiting", "waiting", `?project=${alpha.id}`);
});
test("counts overdue by the limit of the project", async ({ page, desk, signIn, baseURL }) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  await signIn();
  const read = async () =>
    z
      .object({ version: z.number(), config: z.record(z.string(), z.unknown()) })
      .parse(await (await page.request.get(`/api/v1/projects/${alpha.id}/config`)).json());
  // What the server reports is compared with a count over the tickets of the
  // project, whatever earlier tests did to them.
  const reported = async () =>
    overviewSchema.parse(
      await (await page.request.get(`/api/v1/overview?project=${alpha.id}`)).json(),
    ).projects[0]?.overdue ?? 0;
  const expected = async (hours: number) => {
    const list = z
      .array(z.object({ pendingSince: z.string().nullable() }))
      .parse(await (await page.request.get(`/api/v1/tickets?project=${alpha.id}`)).json());
    return list.filter(
      (ticket) =>
        ticket.pendingSince !== null &&
        Date.now() - Date.parse(ticket.pendingSince) >= hours * 3_600_000,
    ).length;
  };
  const original = await read();
  const setLimit = async (hours: number) => {
    const now = await read();
    const response = await page.request.put(`/api/v1/projects/${alpha.id}/config`, {
      headers,
      data: { config: { ...now.config, overdueHours: hours }, expectedVersion: now.version },
    });
    expect(response.ok()).toBe(true);
  };
  try {
    const counts: number[] = [];
    for (const hours of [1, 24, 720]) {
      await setLimit(hours);
      counts.push(await reported());
      expect(counts.at(-1)).toBe(await expected(hours));
    }
    // A longer limit never counts more.
    expect(counts[0]).toBeGreaterThanOrEqual(counts[1] ?? 0);
    expect(counts[1]).toBeGreaterThanOrEqual(counts[2] ?? 0);
    // The page shows the sum over all projects the person may read.
    const all = overviewSchema.parse(await (await page.request.get("/api/v1/overview")).json());
    await page.goto("/");
    await expect(page.locator(".metric", { hasText: "Overdue" }).locator("strong")).toHaveText(
      String(all.projects.reduce((total, row) => total + row.overdue, 0)),
    );
  } finally {
    await setLimit(Number(original.config.overdueHours));
  }
});
