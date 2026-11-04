import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Saved views of the inbox: the filters are saved under a name, applied with one choice, updated, made the start of the
// desk, and deleted. The fixture operator is the only one who has views, and they are removed at the end.
test.describe.configure({ mode: "serial" });
const listSchema = z.object({
  views: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      list: z.string(),
      projects: z.array(z.string()),
      start: z.boolean(),
      restricted: z.boolean(),
    }),
  ),
});
test("saves the filters of the inbox as a view, applies it, opens the desk with it and deletes it", async ({
  page,
  desk,
  signIn,
  baseURL,
  browserName,
}) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  const name = `E2E view ${desk.run} ${browserName}`;
  const read = async () =>
    listSchema.parse(await (await page.request.get("/api/v1/me/views")).json()).views;
  // The page is shown before its scripts run, and a choice that is made in that moment is lost; so a choice is made again
  // until the controls that belong to a chosen view are there.
  const choose = async (label: string) => {
    await expect(async () => {
      await page.getByLabel("Saved views").selectOption({ label }, { timeout: 5_000 });
      await expect(page.getByRole("button", { name: "Delete the view" })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 30_000 });
  };
  // A window of a laptop and the wider letters of another system: the controls of the top bar do not fit in one line.
  await page.setViewportSize({ width: 1100, height: 700 });
  await signIn();
  try {
    await page.goto("/");
    const nav = page.getByRole("navigation");
    await nav.getByRole("button", { name: "Waiting for customer" }).click();
    // The button of the project filter; a ticket row of the list can carry the name of the project too.
    const filter = page.locator("button.filter-trigger");
    await filter.click();
    await page.getByRole("checkbox", { name: alpha.name, exact: true }).check();
    await filter.click();
    await expect(filter).toHaveText(alpha.name);
    // Every control of the top bar is inside it, also when it wraps, so that it can be clicked.
    const bar = await page.locator("header.topbar").boundingBox();
    for (const control of await page.locator("header.topbar").getByRole("button").all()) {
      const box = await control.boundingBox();
      expect(box && bar && box.y >= bar.y && box.y + box.height <= bar.y + bar.height + 1).toBe(
        true,
      );
    }
    // Saving needs a name.
    await page.getByRole("button", { name: "Save the filters as a view" }).click();
    const save = page.getByRole("button", { name: "Save view", exact: true });
    await expect(save).toBeDisabled();
    await page.getByLabel("Name of the view").fill(name);
    await save.click();
    const options = page.getByLabel("Saved views");
    await expect(options.locator("option", { hasText: name })).toHaveCount(1);
    const saved = (await read()).find((view) => view.name === name);
    expect(saved).toMatchObject({
      list: "waiting",
      projects: [alpha.id],
      start: false,
      restricted: false,
    });
    // The same name again is refused.
    await page.getByRole("button", { name: "Save the filters as a view" }).click();
    await page.getByLabel("Name of the view").fill(name.toUpperCase());
    await page.getByRole("button", { name: "Save view", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "already" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    // Another list first, then the view brings the filters back.
    await nav.getByRole("button", { name: "Resolved" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Resolved" })).toBeVisible();
    await choose(name);
    await expect(
      page.getByRole("heading", { level: 1, name: "Waiting for customer" }),
    ).toBeVisible();
    // Start with it: the desk opens with the view and not with the overview.
    await page.getByRole("button", { name: "Open the desk with this view" }).click();
    await expect(
      page.getByRole("button", { name: "Do not open the desk with this view" }),
    ).toBeVisible();
    expect((await read()).find((view) => view.id === saved?.id)?.start).toBe(true);
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "Waiting for customer" }),
    ).toBeVisible();
    await expect(page.locator("button.filter-trigger")).toHaveText(alpha.name);
    // A link to a ticket opens that ticket and not the view.
    await page.goto(`/?ticket=${alpha.tickets[0]}`);
    await expect(page.getByRole("region", { name: "Ticket" })).toBeVisible();
    // Without the start the desk opens with the overview again.
    await page.goto("/");
    await choose(`${name} (start)`);
    const ended = page.waitForResponse((response) => response.url().endsWith("/start"));
    await page.getByRole("button", { name: "Do not open the desk with this view" }).click();
    const answer = await ended;
    expect(answer.request().postData()).toBe('{"start":false}');
    expect(answer.status()).toBe(200);
    await expect(page.getByRole("button", { name: "Open the desk with this view" })).toBeVisible();
    expect((await read()).find((view) => view.id === saved?.id)?.start).toBe(false);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    // Deleting removes it from the list.
    await choose(name);
    await page.getByRole("button", { name: "Delete the view" }).click();
    await expect(page.getByLabel("Saved views").locator("option", { hasText: name })).toHaveCount(
      0,
    );
    expect((await read()).some((view) => view.name === name)).toBe(false);
  } finally {
    for (const view of await read())
      if (view.name === name)
        await page.request.post(`/api/v1/me/views/${view.id}/delete`, { headers, data: {} });
  }
});
