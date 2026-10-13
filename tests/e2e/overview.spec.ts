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
  const all = await read();
  const sum = (
    rows: typeof all.projects,
    key: "overdue" | "unassigned" | "remindersDue" | "waiting",
  ) => rows.reduce((total, row) => total + row[key], 0);
  await page.goto("/");
  const metric = (label: string) => page.locator(".metric", { hasText: label }).locator("strong");
  await expect(metric("Overdue")).toHaveText(String(sum(all.projects, "overdue")));
  await expect(metric("Unassigned")).toHaveText(String(sum(all.projects, "unassigned")));
  await expect(metric("Reminders due")).toHaveText(String(sum(all.projects, "remindersDue")));
  await expect(metric("Waiting")).toHaveText(String(sum(all.projects, "waiting")));
  // One project only: the counts follow the filter and are those of the API.
  const one = await read(`?project=${alpha.id}`);
  expect(one.projects.map((row) => row.projectId)).toEqual([alpha.id]);
  expect(one.oldest.every((ticket) => ticket.projectId === alpha.id)).toBe(true);
  await page.getByRole("button", { name: "All projects" }).click();
  await page.getByRole("checkbox", { name: alpha.name }).check();
  await expect(metric("Unassigned")).toHaveText(String(sum(one.projects, "unassigned")));
  await expect(metric("Waiting")).toHaveText(String(sum(one.projects, "waiting")));
});
test("counts overdue by the limit of the project", async ({ page, desk, signIn, baseURL }) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  await signIn();
  const read = async () =>
    z
      .object({ version: z.number(), config: z.record(z.string(), z.unknown()) })
      .parse(await (await page.request.get(`/api/v1/projects/${alpha.id}/config`)).json());
  const overdue = async () =>
    (await read(),
    overviewSchema.parse(
      await (await page.request.get(`/api/v1/overview?project=${alpha.id}`)).json(),
    )).projects[0]?.overdue ?? 0;
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
    await setLimit(24);
    const normal = await overdue();
    expect(normal).toBeGreaterThan(0);
    await setLimit(720);
    expect(await overdue()).toBe(0);
    // The page shows the sum over all projects the person may read.
    const all = overviewSchema.parse(await (await page.request.get("/api/v1/overview")).json());
    await page.goto("/");
    await expect(page.locator(".metric", { hasText: "Overdue" }).locator("strong")).toHaveText(
      String(all.projects.reduce((total, row) => total + row.overdue, 0)),
    );
    await setLimit(1);
    expect(await overdue()).toBeGreaterThanOrEqual(normal);
  } finally {
    await setLimit(Number(original.config.overdueHours));
  }
});
