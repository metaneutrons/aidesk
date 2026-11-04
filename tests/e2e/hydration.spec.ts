import { expect, test } from "./fixtures";
// A navigation of the page returns when the page has taken its handlers. The page is asked for with "commit", which
// returns as soon as the server has answered and before any script ran; without the wait of the fixture the click
// on the menu would land on a button that does nothing yet.
test("a click right after the navigation takes effect", async ({ page, signIn }) => {
  await signIn();
  for (let round = 0; round < 3; round += 1) {
    await page.goto("/", { waitUntil: "commit" });
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible({
      timeout: 3_000,
    });
  }
});
