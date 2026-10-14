import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";
// Webhooks: defined through the API, shown on the settings page with the outcome
// of the last delivery, tested with an event and disabled. The page never shows
// the signing secret.
test.describe.configure({ mode: "serial" });
test("shows a webhook with its last delivery, sends a test event and disables it", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  const name = `Hook ${desk.run}`;
  await signIn();
  const created = await page.request.post(`/api/v1/projects/${alpha.id}/webhooks`, {
    headers,
    data: {
      name,
      // An address nothing answers on from the worker, which
      // is enough to see a failed delivery on the page.
      url: "http://localhost:3000/api/health/live",
      events: ["ticket.created"],
      secret: "never-shown-signing-secret",
      developmentOnly: true,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: `Webhooks of ${alpha.name}` });
  const row = section.getByRole("listitem").filter({ hasText: name });
  await expect(row.getByText("Nothing delivered yet")).toBeVisible();
  await expect(page.getByText("never-shown-signing-secret")).toHaveCount(0);
  const listed = await (await page.request.get(`/api/v1/projects/${alpha.id}/webhooks`)).text();
  expect(listed).not.toContain("never-shown");
  expect(listed).toContain('"secretSet":true');
  await row.getByRole("button", { name: `Send a test event to ${name}` }).click();
  await expect(section.getByText(/A test event was queued/)).toBeVisible();
  // The worker delivers it; the answer of the endpoint is shown, with the pause.
  await expect(async () => {
    await page.reload();
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    await expect(
      section
        .getByRole("listitem")
        .filter({ hasText: name })
        .getByText(/Failed .* \(\w+\), trying again/),
    ).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  await row.getByRole("button", { name: `Disable ${name}` }).click();
  await expect(row.getByText("Disabled")).toBeVisible();
  await expect(row.getByRole("button", { name: `Send a test event to ${name}` })).toBeDisabled();
});
