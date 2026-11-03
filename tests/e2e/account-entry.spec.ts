import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, openAccount, openSettings, test } from "./fixtures";
// The account of the person (profile, notifications, sign-in) is behind their name at the bottom of the menu, and not in
// the list of the settings. The topics keep their addresses, the browser's back button leads from one area to the other,
// and on a narrow screen the entry is in the panel of the last tab.
const scan = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
const topics = ["Profile", "Notifications", "Sign-in and security"];
test("opens the account from the name at the bottom of the menu and keeps it out of the settings", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.goto("/");
  const entry = page.getByRole("button", { name: /^Account of / });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(entry).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  const list = page.getByRole("complementary", { name: "Topics" });
  for (const topic of topics) await expect(list.getByRole("link", { name: topic })).toBeVisible();
  // Nothing of the settings of the workspace is in this list.
  await expect(list.getByRole("link", { name: "People" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Profile" })).toBeVisible();
  await expect(page).toHaveURL(/\/\?settings=account$/);
  await list.getByRole("link", { name: "Notifications" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Notifications" })).toBeVisible();
  await expect(page).toHaveURL(/\/\?settings=notifications$/);
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  // The settings do not hold the account any more.
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  for (const topic of topics)
    await expect(list.getByRole("link", { name: topic, exact: true })).toHaveCount(0);
  await expect(list.getByRole("link", { name: "People" })).toBeVisible();
  await expect(entry).not.toHaveAttribute("aria-current", "page");
});
test("keeps the addresses of the topics, and the back button leads from one area to the other", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.goto("/?settings=security");
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Sign-in and security" })).toBeVisible();
  await page.goto("/?settings=notifications");
  await expect(page.getByRole("heading", { level: 2, name: "Notifications" })).toBeVisible();
  await page.goto("/?settings=people");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "People" })).toBeVisible();
  // From the settings to the account and back with the browser's buttons.
  await openAccount(page);
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  await page.getByRole("link", { name: "Sign-in and security" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Sign-in and security" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/\?settings=account$/);
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  // Back from the account over the border of the areas: the settings topic that was open before is the entry that is left.
  await page.goto("/?settings=");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await page.getByRole("link", { name: "Limits and controls", exact: true }).click();
  await expect(page).toHaveURL(/\/\?settings=workspace$/);
  await openAccount(page);
  await expect(page).toHaveURL(/\/\?settings=account$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/\?settings=$/);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  // The list of the area is not a topic of the other.
  await page.goto("/?settings=account");
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
test("opens the same topics through the helper of the other specs", async ({ page, signIn }) => {
  await signIn();
  await page.goto("/");
  await openSettings(page, "Profile");
  await openSettings(page, "People");
  await openSettings(page, "Sign-in and security");
  await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
});
test.describe("on a narrow screen", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("is in the panel of the last tab, shows the three topics one after the other and goes back to them", async ({
    page,
    signIn,
  }) => {
    await signIn();
    await page.goto("/");
    const entry = page.getByRole("button", { name: /^Account of / });
    // Closed with the panel, shown with it.
    await expect(entry).toBeHidden();
    await openAccount(page);
    const list = page.getByRole("complementary", { name: "Topics" });
    await expect(list).toBeVisible();
    for (const topic of topics) await expect(list.getByRole("link", { name: topic })).toBeVisible();
    await expect(page.locator(".settings-detail")).toBeHidden();
    expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
    await list.getByRole("link", { name: "Profile" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Profile" })).toBeVisible();
    // The button that goes back is named for the account, not for the settings.
    const back = page.locator(".settings-back");
    await expect(back).toHaveText("Account");
    await back.click();
    await expect(list).toBeVisible();
    // The address of the list shows the list, not a topic, and a reload keeps it so.
    await page.goto("/?settings=account");
    await expect(list).toBeVisible();
    await expect(page.locator(".settings-detail")).toBeHidden();
    // The tabs are the same six as before.
    await expect(page.getByRole("navigation").getByRole("button")).toHaveCount(6);
  });
});
test.describe("in German", () => {
  test.use({ locale: "de-DE" });
  test("names the entry and the area in German", async ({ page, signIn }) => {
    await signIn();
    await page.goto("/");
    await page.getByRole("button", { name: /^Konto von / }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Konto" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Profil" })).toBeVisible();
  });
});
