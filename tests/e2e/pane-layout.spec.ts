import { expect, test } from "./fixtures";
// The width of the ticket list and whether it is shown are the person's own and stay in the browser.
test("sets the width of the list with the handle and the keyboard, hides it and remembers both", async ({
  page,
  desk,
  signIn,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn();
  await page.goto(`/?ticket=${desk.projects.alpha.tickets[0]}`);
  const list = page.getByRole("region", { name: "Inbox" });
  const handle = page.getByRole("separator", { name: "Width of the list" });
  const width = async () => Math.round((await list.boundingBox())?.width ?? 0);
  await expect(handle).toHaveAttribute("aria-valuenow", "350");
  await expect(handle).toHaveAttribute("aria-valuemin", "260");
  await expect(handle).toHaveAttribute("aria-valuemax", "560");
  // The keyboard: a step, a larger step with Shift, the smallest and the largest width.
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "366");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "430");
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "260");
  await expect.poll(width).toBe(260);
  await page.keyboard.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", "560");
  // A double click returns to the usual width.
  await handle.dblclick();
  await expect(handle).toHaveAttribute("aria-valuenow", "350");
  // The list takes a moment to reach its width, and the handle moves with it.
  await expect.poll(width).toBe(350);
  // The pointer: dragged by 70 pixels, and the list follows.
  const box = await handle.boundingBox();
  if (!box) throw new Error("The handle has no box.");
  await page.mouse.move(box.x + 1, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 71, box.y + 200, { steps: 5 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "420");
  await expect.poll(width).toBe(420);
  // The width is still there after a reload, and the page opens with it.
  await page.reload();
  await expect(handle).toHaveAttribute("aria-valuenow", "420");
  await expect.poll(width).toBe(420);
  // The list can be hidden and shown again, with the button and with Enter on the handle.
  await page.getByRole("button", { name: "Hide list" }).click();
  await expect(list).toBeHidden();
  await expect(handle).toBeHidden();
  await page.reload();
  await expect(list).toBeHidden();
  const show = page.getByRole("button", { name: "Show list" });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await show.click();
  await expect(list).toBeVisible();
  await expect.poll(width).toBe(420);
  await handle.focus();
  await page.keyboard.press("Enter");
  await expect(list).toBeHidden();
});
test("ignores a stored layout that is not valid and keeps the arrow keys inside the list", async ({
  page,
  desk,
  signIn,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn();
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("aidesk:layout", '{"listWidth":50,"listCollapsed":"yes"}');
  });
  await page.goto(`/?ticket=${desk.projects.alpha.tickets[0]}`);
  const list = page.getByRole("region", { name: "Inbox" });
  await expect(page.getByRole("separator", { name: "Width of the list" })).toHaveAttribute(
    "aria-valuenow",
    "350",
  );
  await expect(list).toBeVisible();
  // The arrow keys move the focus from row to row.
  const rows = list.getByRole("button").filter({ hasText: "request" });
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(rows.first()).toBeFocused();
});
