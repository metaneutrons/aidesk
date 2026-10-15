import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";
// The search in the sources of knowledge of a ticket. The fixture project has none; what a source
// gives and how one that fails is shown is in the knowledge tests.
test("searches the knowledge of the project and says that it has no sources", async ({
  page,
  desk,
  signIn,
}) => {
  const { alpha } = desk.projects;
  await signIn();
  await page.goto(`/?ticket=${alpha.tickets[0]}`);
  const panel = page.getByRole("region", { name: "Ticket" });
  await panel.getByText("Knowledge", { exact: true }).click();
  const field = panel.getByRole("searchbox", { name: "Words to search for" });
  const search = panel.getByRole("button", { name: "Search", exact: true });
  await expect(search).toBeDisabled();
  await field.fill("printer");
  await search.click();
  await expect(panel.getByText("This project has no sources of knowledge.")).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
});
