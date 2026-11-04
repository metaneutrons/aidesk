import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, openSettings, remote, test } from "./fixtures";
// The updates in the settings, as the owner uses them, against the stand-in for the updater of the development stack
// (scripts/updater-stub.mjs): the version and the release, an update step by step with the restart of the desk in the
// middle, one that is put back, the maintenance window, what the page says when there is no updater, and what it says
// when Coolify runs the installation. The stand-in
// is one process for the whole installation, so one browser runs this and the tests follow each other.
test.describe.configure({ mode: "serial" });
test.skip(remote, "The stand-in for the updater belongs to the development stack.");
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "The updater is global; one browser changes it.",
);
const stub = "http://127.0.0.1:8099/__stub";
const reset = async (page: Page) => {
  expect((await page.request.post(`${stub}/reset`)).ok()).toBe(true);
};
const scenario = async (page: Page, outcome: "success" | "rollback", stepMs: number) => {
  expect((await page.request.post(`${stub}/scenario`, { data: { outcome, stepMs } })).ok()).toBe(
    true,
  );
};
const scan = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
const section = (page: Page) =>
  page
    .locator("section.updates")
    .filter({ has: page.getByRole("heading", { level: 3, name: "Updates" }) });
const value = (page: Page, label: string) =>
  section(page).locator(".row").filter({ hasText: label }).locator("output");
test.beforeEach(async ({ page }) => {
  await reset(page);
});
test.afterAll(async ({ request }) => {
  await request.post(`${stub}/reset`);
});
test("shows the version that runs, the latest release and the maintenance window", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.goto("/");
  await openSettings(page, "Updates");
  const updates = section(page);
  await expect(updates).toBeVisible();
  await expect(value(page, "Installed")).toHaveText("0.1.0");
  await expect(value(page, "Latest release")).toHaveText("0.2.0");
  await expect(updates.locator(".update-state")).toContainText("Version 0.2.0 is available.");
  await expect(updates.getByRole("button", { name: "Install 0.2.0" })).toBeEnabled();
  await expect(updates.getByRole("radio", { name: "Manual" })).toBeChecked();
  await expect(updates.getByLabel("Time of day")).toHaveValue("02:00");
  await expect(updates.getByRole("button", { name: "Save" })).toBeDisabled();
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
});
test("asks before it installs, goes through the steps, survives the restart and ends in the new version", async ({
  page,
  signIn,
}) => {
  await signIn();
  await scenario(page, "success", 700);
  await page.goto("/");
  await openSettings(page, "Updates");
  const updates = section(page);
  await expect(updates.getByRole("button", { name: "Install 0.2.0" })).toBeEnabled();
  // The first click only asks, and says what happens; cancelling changes nothing.
  await updates.getByRole("button", { name: "Install 0.2.0" }).click();
  await expect(updates.getByText("unavailable for about a minute")).toBeVisible();
  await updates.getByRole("button", { name: "Cancel" }).click();
  await expect(updates.getByRole("button", { name: "Install 0.2.0" })).toBeVisible();
  await expect(updates.getByText("unavailable for about a minute")).toBeHidden();
  expect(
    (await (await page.request.get("/api/v1/workspace/updates")).json()) as { status: object },
  ).toMatchObject({ status: { state: "available" } });
  // The page is told to load again when the update is done: this mark is gone afterwards.
  await page.evaluate(() => {
    (window as unknown as Record<string, boolean>).stayed = true;
  });
  // The desk does not answer while its containers are replaced.
  let away = true;
  await page.route("**/api/v1/workspace/updates", async (route) => {
    if (away && route.request().method() === "GET") await route.abort();
    else await route.continue();
  });
  await updates.getByRole("button", { name: "Install 0.2.0" }).click();
  await updates.getByRole("button", { name: "Install 0.2.0 now" }).click();
  await expect(updates.locator(".update-state")).toContainText("The desk restarts");
  away = false;
  // The steps are listed with where each stands.
  await expect(updates.locator('.update-steps li[data-state="done"]').first()).toBeVisible();
  await expect(updates.locator(".update-state")).toContainText(
    /Installing version 0\.2\.0|Updated to version 0\.2\.0/,
  );
  await expect(updates.locator(".update-state")).toContainText("Updated to version 0.2.0");
  // Then the page loads itself again, and shows the new version at rest.
  await expect.poll(() => page.evaluate(() => "stayed" in window), { timeout: 20_000 }).toBe(false);
  await openSettings(page, "Updates");
  await expect(value(page, "Installed")).toHaveText("0.2.0");
  await expect(section(page).locator(".update-state")).toContainText("This is the latest release.");
  await expect(section(page).getByRole("button", { name: /^Install / })).toBeDisabled();
  // The owner's action is an entry of the audit of the workspace.
  const audit = z
    .object({
      entries: z.array(
        z.object({ action: z.string(), detail: z.record(z.string(), z.unknown()).nullable() }),
      ),
    })
    .parse(await (await page.request.get("/api/v1/audit?action=updates.")).json());
  expect(audit.entries.find((entry) => entry.action === "updates.apply")?.detail).toMatchObject({
    from: "0.1.0",
    to: "v0.2.0",
  });
});
test("says that the previous version was put back when the new one did not start", async ({
  page,
  signIn,
}) => {
  await signIn();
  await scenario(page, "rollback", 300);
  await page.goto("/");
  await openSettings(page, "Updates");
  const updates = section(page);
  await updates.getByRole("button", { name: "Install 0.2.0" }).click();
  await updates.getByRole("button", { name: "Install 0.2.0 now" }).click();
  await expect(
    updates.getByRole("alert").filter({ hasText: "previous version was put back" }),
  ).toBeVisible({
    timeout: 20_000,
  });
  // The step that failed is marked, the version is the old one, and another try is possible.
  await expect(updates.locator('.update-steps li[data-state="failed"]')).toContainText(
    "Wait until the new version answers",
  );
  await expect(value(page, "Installed")).toHaveText("0.1.0");
  await expect(updates.getByRole("button", { name: "Install 0.2.0" })).toBeEnabled();
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  // The marks of the failed step and of the notice are in the colour of an error, which has to be readable on dark too.
  await page.emulateMedia({ colorScheme: "dark" });
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
});
test("saves the maintenance window and refuses a change while an update runs", async ({
  page,
  signIn,
  baseURL,
}) => {
  await signIn();
  await page.goto("/");
  await openSettings(page, "Updates");
  const updates = section(page);
  await updates.getByRole("radio", { name: "Automatic" }).check();
  await updates.getByLabel("Time of day").fill("03:30");
  await updates.getByLabel("Time zone").selectOption("Europe/Berlin");
  await updates.getByRole("button", { name: "Save" }).click();
  await expect(updates.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  const read = async () =>
    (await (await page.request.get("/api/v1/workspace/updates")).json()) as {
      status: { updateMode: string; maintenanceTime: string; timezone: string; state: string };
    };
  expect((await read()).status).toMatchObject({
    updateMode: "automatic",
    maintenanceTime: "03:30",
    timezone: "Europe/Berlin",
  });
  await page.reload();
  await openSettings(page, "Updates");
  await expect(section(page).getByRole("radio", { name: "Automatic" })).toBeChecked();
  await expect(section(page).getByLabel("Time of day")).toHaveValue("03:30");
  // While an update runs neither the window nor a second update is accepted.
  await scenario(page, "success", 2000);
  const headers = { origin: baseURL ?? "" };
  expect((await page.request.post("/api/v1/workspace/updates/apply", { headers })).status()).toBe(
    200,
  );
  expect((await read()).status.state).toBe("updating");
  const schedule = { mode: "manual", maintenanceTime: "04:00", timezone: "UTC" };
  expect(
    (
      await page.request.put("/api/v1/workspace/updates/schedule", { headers, data: schedule })
    ).status(),
  ).toBe(409);
  expect((await page.request.post("/api/v1/workspace/updates/apply", { headers })).status()).toBe(
    409,
  );
  // A value the updater would refuse is not passed on.
  await expect.poll(async () => (await read()).status.state, { timeout: 20_000 }).toBe("current");
  expect(
    (
      await page.request.put("/api/v1/workspace/updates/schedule", {
        headers,
        data: { ...schedule, maintenanceTime: "25:00" },
      })
    ).status(),
  ).toBe(400);
});
test("says what is wrong when there is no updater, when it does not answer and when it refuses the token", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.goto("/");
  for (const [availability, text] of [
    ["not-configured", "This installation has no updater"],
    ["unreachable", "The updater does not answer"],
    ["unauthorized", "The updater refused the token"],
  ] as const) {
    await page.route("**/api/v1/workspace/updates", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { availability, status: null } })
        : route.continue(),
    );
    await page.goto("/");
    await openSettings(page, "Updates");
    await expect(section(page)).toContainText(text);
    await expect(section(page).getByRole("button")).toHaveCount(0);
    expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
    await page.unroute("**/api/v1/workspace/updates");
  }
});
test("says that Coolify runs the installation and offers no check, no installation and no schedule", async ({
  page,
  signIn,
  baseURL,
}) => {
  await signIn();
  // The updater found the labels of Coolify and reports it: the status is there, the page offers nothing of it.
  expect((await page.request.post(`${stub}/status`, { data: { managedBy: "coolify" } })).ok()).toBe(
    true,
  );
  await page.goto("/");
  await openSettings(page, "Updates");
  const updates = section(page);
  await expect(updates).toContainText("This installation is run by Coolify");
  await expect(updates).toContainText("by deploying the application again");
  await expect(updates.getByRole("button")).toHaveCount(0);
  await expect(updates.getByRole("radio")).toHaveCount(0);
  await expect(value(page, "Installed")).toHaveCount(0);
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  // The API says the same and refuses to install or to schedule, although a release is waiting.
  const read = (await (await page.request.get("/api/v1/workspace/updates")).json()) as {
    managedBy: string;
    status: { updateAvailable: boolean };
  };
  expect(read.managedBy).toBe("coolify");
  expect(read.status.updateAvailable).toBe(true);
  const headers = { origin: baseURL ?? "" };
  const count = async () =>
    z
      .object({ entries: z.array(z.object({ action: z.string() })) })
      .parse(await (await page.request.get("/api/v1/audit?action=updates.")).json()).entries.length;
  const before = await count();
  expect((await page.request.post("/api/v1/workspace/updates/apply", { headers })).status()).toBe(
    409,
  );
  expect(
    (
      await page.request.put("/api/v1/workspace/updates/schedule", {
        headers,
        data: { mode: "automatic", maintenanceTime: "03:00", timezone: "UTC" },
      })
    ).status(),
  ).toBe(409);
  // Nothing was written down as an installation or a schedule by these two requests.
  expect(await count()).toBe(before);
  // Without the updater being asked at all: the application knows it from its own environment.
  await page.emulateMedia({ colorScheme: "light" });
  await page.route("**/api/v1/workspace/updates", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: { availability: "not-configured", status: null, managedBy: "coolify" },
        })
      : route.continue(),
  );
  await page.goto("/");
  await openSettings(page, "Updates");
  await expect(section(page)).toContainText("This installation is run by Coolify");
  await expect(section(page)).not.toContainText("has no updater");
  await expect(section(page).getByRole("button")).toHaveCount(0);
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  await page.unroute("**/api/v1/workspace/updates");
});
