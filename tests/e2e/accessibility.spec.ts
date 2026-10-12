import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
// Automated WCAG 2.2 A/AA rules only. They find a subset of barriers; manual
// keyboard, screen-reader and zoom checks are still required.
const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function audit(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(tags)
    // Base UI gives its visually hidden dialog focus guards role="button" in
    // WebKit on purpose, so VoiceOver's virtual cursor stays in the focus trap.
    .exclude("[data-base-ui-focus-guard]")
    .analyze();
  return result.violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target.join(" ")),
  }));
}
for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} appearance`, () => {
    test.use({ colorScheme });
    test("sign-in page has no automatically detectable violations", async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await audit(page)).toEqual([]);
    });
    test("desk views have no automatically detectable violations", async ({
      page,
      desk,
      signIn,
    }) => {
      await signIn();
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Overview");
      expect(await audit(page)).toEqual([]);
      await page.goto(`/?ticket=${desk.projects.alpha.tickets[0]}`);
      await expect(
        page.getByRole("textbox", { name: "Write your reply in Markdown…" }),
      ).toBeVisible();
      expect(await audit(page)).toEqual([]);
      await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("heading", { name: "Operators" })).toBeVisible();
      expect(await audit(page)).toEqual([]);
      await page.getByRole("button", { name: "New project" }).click();
      await expect(page.getByRole("dialog", { name: "New project" })).toBeVisible();
      expect(await audit(page)).toEqual([]);
    });
  });
}
