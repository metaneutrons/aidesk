import { expect, test } from "./fixtures";
// The tools of a ticket (assignee, tags, reminder, link, junk, erase) are in groups under the title. On a screen that is
// not high enough they are closed behind Details, so that the conversation and the composer keep their room.
test("keeps the composer in view on a low screen and opens the tools on request", async ({
  page,
  desk,
  signIn,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signIn();
  await page.goto(`/?ticket=${desk.projects.alpha.tickets[0]}`);
  const send = page.getByRole("button", { name: "Send reply" });
  await expect(send).toBeVisible();
  const box = await send.boundingBox();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(720);
  const portal = page.getByRole("button", { name: "Create portal link" });
  await expect(portal).toBeHidden();
  const details = page.getByRole("button", { name: "Details", exact: true });
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(portal).toBeVisible();
  // The destructive actions are last and set apart.
  const junk = page.getByRole("button", { name: "Move to junk" });
  const erase = page.getByRole("button", { name: "Erase this ticket…" });
  await expect(junk).toBeVisible();
  await expect(erase).toBeVisible();
  const portalBox = await portal.boundingBox();
  const junkBox = await junk.boundingBox();
  expect(junkBox?.y ?? 0).toBeGreaterThan((portalBox?.y ?? 0) + 20);
});
test("shows the tools at once on a high screen", async ({ page, desk, signIn }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn();
  await page.goto(`/?ticket=${desk.projects.alpha.tickets[0]}`);
  await expect(page.getByRole("button", { name: "Create portal link" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Details", exact: true })).toBeHidden();
});
