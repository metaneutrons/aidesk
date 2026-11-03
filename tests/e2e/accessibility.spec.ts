import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, openSettings, test } from "./fixtures";
// Automated WCAG 2.2 A/AA rules only. They find a subset of barriers; manual
// keyboard, screen-reader and zoom checks are still required.
const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function audit(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(tags)
    // Base UI gives its visually hidden dialog focus guards role="button" in
    // WebKit on purpose, so VoiceOver's virtual cursor stays in the focus trap.
    .exclude("[data-base-ui-focus-guard]")
    // Previews of mail show other people's markup in a frame without scripts,
    // which the scanner cannot enter reliably (it sometimes stalls). The mail
    // template is scanned on its own in designs.spec.ts.
    .exclude(".design-frame")
    .exclude(".original-frame")
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
      await page.getByRole("navigation").getByRole("button", { name: "Junk" }).click();
      await expect(page.getByRole("region", { name: "Junk" })).toBeVisible();
      expect(await audit(page)).toEqual([]);
      await openSettings(page, "People");
      await expect(page.getByRole("heading", { level: 2, name: "People" })).toBeVisible();
      expect(await audit(page)).toEqual([]);
      await openSettings(page, "Projects");
      expect(await audit(page)).toEqual([]);
      await page.getByRole("button", { name: "New project" }).click();
      await expect(page.getByRole("dialog", { name: "New project" })).toBeVisible();
      expect(await audit(page)).toEqual([]);
    });
    test("every topic of the settings has no automatically detectable violations", async ({
      page,
      signIn,
    }) => {
      // One scan for each of some twenty topics is more than the time of an ordinary test.
      test.setTimeout(300_000);
      await signIn();
      await page.goto("/");
      await openSettings(page, "People");
      const list = page.getByRole("complementary", { name: "Topics" });
      // The topics of the project come with the answer about the rights of the person.
      await expect(list.getByRole("link", { name: "General" })).toBeVisible();
      const topics = await list.getByRole("link").allInnerTexts();
      expect(topics.length).toBeGreaterThan(10);
      for (const topic of topics) {
        await openSettings(page, topic.trim());
        expect(await audit(page), topic).toEqual([]);
      }
    });
  });
}
