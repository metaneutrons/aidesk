import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, fixture, test } from "./fixtures";
// The notifications of an operator in the desk: the number of unread ones next to the entry of the navigation, the
// list with the number and the subject of the ticket, the opening of the ticket and the marking as read, and the
// choice of channels in the settings. The notification is written as the rules of the project would write it; what
// the rules do is the business of the unit tests.
test.describe.configure({ mode: "serial" });
const preferences = z.object({
  preferences: z.array(z.object({ kind: z.string(), desk: z.boolean(), mail: z.boolean() })),
});
// The worker of the development stack writes notifications of its own (tickets of the fixtures are overdue), so the
// tests look for the kind "mention", which only they write, and do not count what is unread.
test("shows a notification, opens its ticket and marks it as read", async ({
  page,
  desk,
  signIn,
}) => {
  const ticket = desk.projects.alpha.tickets[0];
  await signIn();
  fixture("notify", ticket);
  await page.goto("/");
  const entry = page.getByRole("navigation").getByRole("button", { name: /^Notifications/ });
  await expect(entry.locator(".nav-count")).toBeVisible();
  await entry.click();
  const section = page.locator("section.notifications");
  const mine = section.getByRole("listitem").filter({ hasText: "You were mentioned" });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(desk.projects.alpha.name);
  await expect(mine).toHaveClass(/unread/);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // A click opens the ticket and the notification is read afterwards.
  await mine.getByRole("button").first().click();
  await expect(page).toHaveURL(new RegExp(`ticket=${ticket}`));
  await entry.click();
  await expect(mine).toHaveClass(/read/);
  // With "Unread only" it is gone from the list.
  await section.getByLabel("Unread only").check();
  await expect(mine).toHaveCount(0);
});
test("marks all as read", async ({ page, desk, signIn }) => {
  await signIn();
  fixture("notify", desk.projects.alpha.tickets[1]);
  await page.goto("/");
  const entry = page.getByRole("navigation").getByRole("button", { name: /^Notifications/ });
  await entry.click();
  const section = page.locator("section.notifications");
  const mine = section.getByRole("listitem").filter({ hasText: "You were mentioned" });
  await expect(mine.filter({ hasText: desk.projects.alpha.name }).first()).toHaveClass(/unread/);
  await section.getByRole("button", { name: "Mark all as read" }).click();
  await expect(section.getByRole("listitem").filter({ has: page.locator(".unread") })).toHaveCount(
    0,
  );
  await section.getByLabel("Unread only").check();
  await expect(mine).toHaveCount(0);
});
test("chooses the channels for a kind in the settings and keeps the choice", async ({
  page,
  signIn,
  baseURL,
}) => {
  await signIn();
  const read = async () =>
    preferences.parse(await (await page.request.get("/api/v1/me/notification-preferences")).json());
  const original = (await read()).preferences;
  try {
    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    const section = page.locator("section.notification-preferences");
    await expect(section).toBeVisible();
    await expect(section.getByRole("heading", { name: "Your notifications" })).toBeVisible();
    const mail = section.getByRole("checkbox", { name: "Overdue: By mail" });
    await expect(mail).toBeChecked();
    await mail.uncheck();
    await expect(section.getByRole("status")).toContainText("Saved.");
    expect((await read()).preferences.find((row) => row.kind === "overdue")).toMatchObject({
      desk: true,
      mail: false,
    });
    await page.reload();
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    await expect(
      page
        .locator("section.notification-preferences")
        .getByRole("checkbox", { name: "Overdue: By mail" }),
    ).not.toBeChecked();
  } finally {
    await page.request.put("/api/v1/me/notification-preferences", {
      headers: { origin: baseURL ?? "" },
      data: { preferences: original },
    });
  }
});
