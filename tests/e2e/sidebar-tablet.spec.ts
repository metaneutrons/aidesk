import { expect, test } from "./fixtures";
// A tablet in landscape: the menu is the column on the left, the browser bars and the page zoom take height and
// width, and a touch leaves the last element "hovered".
test.use({ locale: "de-DE", hasTouch: true });
test.skip(({ browserName }) => browserName !== "chromium", "Layout test; runs once.");
test("keeps every menu entry inside the menu on a narrow tablet window", async ({
  page,
  signIn,
}) => {
  await page.setViewportSize({ width: 975, height: 545 });
  await signIn();
  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toBeVisible();
  const edge = await sidebar.evaluate((element) => element.getBoundingClientRect().right);
  const rights = await page.locator(".sidebar nav .nav-item:visible").evaluateAll((items) =>
    items.map((item) => {
      const range = document.createRange();
      range.selectNodeContents(item);
      return range.getBoundingClientRect().right;
    }),
  );
  expect(rights.length).toBeGreaterThan(5);
  // The text ends clear of the border of the menu, not at it.
  for (const right of rights) expect(right).toBeLessThanOrEqual(edge - 8);
});
test("scrolls the menu on a low window so that language and appearance can be reached", async ({
  page,
  signIn,
}) => {
  await page.setViewportSize({ width: 975, height: 545 });
  await signIn();
  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toBeVisible();
  const scrolls = await sidebar.evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(scrolls).toBe(true);
  // A container that is only clipped can still be scrolled by a script, but not by a finger.
  expect(await sidebar.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  const appearance = page.locator(".theme-switch");
  await appearance.scrollIntoViewIfNeeded();
  const box = await appearance.boundingBox();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(545);
  // On a window that is high enough nothing needs to scroll.
  await page.setViewportSize({ width: 1210, height: 834 });
  expect(
    await sidebar.evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeLessThanOrEqual(0);
});
test("does not leave a menu entry highlighted after a touch", async ({ page, signIn }) => {
  await page.setViewportSize({ width: 1210, height: 834 });
  await signIn();
  await page.goto("/");
  expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
  const item = page.locator(".sidebar nav .nav-item:not(.active):visible").first();
  const before = await item.evaluate((element) => getComputedStyle(element).backgroundColor);
  await item.hover();
  expect(await item.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(before);
});
