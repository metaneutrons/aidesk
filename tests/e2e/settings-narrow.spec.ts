import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";
// The settings and the menu on the width of a phone: a bar of tabs at the lower edge, the list of topics and a topic one
// after the other, and the part of the menu below the tabs behind the last tab.
test.use({ viewport: { width: 390, height: 844 } });
const scan = (page: import("@playwright/test").Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
test("shows the list of topics, then a topic, and goes back; the menu is a bar of tabs", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.goto("/");
  const tabs = page.getByRole("navigation");
  // The header of the view is inside the window (the column of the desk must not push it out at the top).
  const header = await page.getByRole("heading", { level: 1 }).boundingBox();
  expect(header?.y ?? -1).toBeGreaterThanOrEqual(0);
  // Everything in the header lies inside it, in the overview and in the inbox: the tools wrap into a row of their own
  // and are not cut off.
  const inside = async () => {
    const topbar = await page.locator(".topbar").boundingBox();
    for (const control of await page.locator(".topbar").locator("button, select").all()) {
      const box = await control.boundingBox();
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual((topbar?.height ?? 0) + 1);
    }
  };
  await inside();
  await tabs.getByRole("button", { name: "Inbox" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await inside();
  const bar = await tabs.boundingBox();
  // The bar of tabs lies at the lower edge and spans the width.
  expect(bar?.width).toBeGreaterThan(380);
  expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBeGreaterThan(800);
  // Every tab that is shown lies inside the window, so none needs a swipe to be found.
  for (const tab of await tabs.getByRole("button").all()) {
    const box = await tab.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(391);
  }
  await tabs.getByRole("button", { name: "Settings" }).click();
  const list = page.getByRole("complementary", { name: "Topics" });
  await expect(list).toBeVisible();
  await expect(page.locator(".settings-detail")).toBeHidden();
  // Nothing is marked as open in a list that is shown alone.
  await expect(list.locator('a[aria-current="page"]')).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  // The account is not in this list: it is behind the name of the person.
  await expect(list.getByRole("link", { name: "Profile", exact: true })).toHaveCount(0);
  await list.getByRole("link", { name: "People", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "People" })).toBeVisible();
  await expect(list).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  await page.locator(".settings-back").click();
  await expect(list).toBeVisible();
});
test("the last tab opens language, appearance and sign-out above the bar", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.goto("/");
  // A badge on a tab (the overdue tickets of the fixture) stays inside the window.
  for (const badge of await page.locator(".nav-count").all()) {
    const box = await badge.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  }
  const more = page.getByRole("navigation").getByRole("button", { name: "More" });
  await expect(page.getByRole("combobox", { name: "Language" })).toBeHidden();
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const language = page.getByRole("combobox", { name: "Language" });
  await expect(language).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  // The panel lies above the bar and inside the window.
  const panel = await language.boundingBox();
  const bar = await page.getByRole("navigation").boundingBox();
  expect((panel?.y ?? 0) + (panel?.height ?? 0)).toBeLessThan(bar?.y ?? 0);
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  // The views without a tab are in the panel.
  await page.getByRole("button", { name: "Junk" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Junk" })).toBeVisible();
  await expect(language).toBeHidden();
  await more.click();
  // A tab closes the panel again.
  await page.getByRole("navigation").getByRole("button", { name: "Inbox" }).click();
  await expect(language).toBeHidden();
});
// The German names are longer; all six tabs still lie inside the window and none is cut off.
test.describe("in German", () => {
  test.use({ locale: "de-DE" });
  test("shows every tab whole", async ({ page, signIn }) => {
    await signIn();
    await page.goto("/");
    const tabs = page.getByRole("navigation").getByRole("button");
    await expect(tabs).toHaveCount(6);
    for (const tab of await tabs.all()) {
      const box = await tab.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(391);
      expect(await tab.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
        true,
      );
    }
  });
});
