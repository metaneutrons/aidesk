import AxeBuilder from "@axe-core/playwright";
import { expect, fixture, test } from "./fixtures";
// Issues from a ticket: the panel appears when the project has a repository, a draft is written and
// read as it will go out, and a publication that GitHub refuses leaves the draft where it was. The
// "GitHub" of this test is the address of the app itself, which refuses everything it is asked.
// The project is gamma: the knowledge spec expects alpha to have no sources, and the repository of this
// test is a source.
test.describe.configure({ mode: "serial" });
test("writes a draft of an issue, reviews it and keeps it when the repository refuses", async ({
  page,
  desk,
  signIn,
}) => {
  const { gamma } = desk.projects;
  await signIn();
  await page.goto(`/?ticket=${gamma.tickets[0]}`);
  const panel = page.getByRole("region", { name: "Ticket" });
  // No repository, no controls.
  await expect(panel.getByText("Issues", { exact: true })).toHaveCount(0);
  // A repository that refuses every request, as a ready connection of the project.
  fixture("github-source", gamma.id);
  await page.goto(`/?ticket=${gamma.tickets[0]}`);
  await panel.getByText("Issues", { exact: true }).click();
  await expect(panel.getByText(/nothing of the ticket is added/)).toBeVisible();
  await panel.getByLabel("Title").fill("Printer prints grey pages");
  await panel.getByLabel("Text").fill("Steps to reproduce: print a test page.");
  await panel.getByRole("button", { name: "Save draft" }).click();
  const card = panel.locator(".issue-draft");
  await expect(card).toContainText("acme/app: Printer prints grey pages");
  await expect(card).toContainText("draft");
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // The review shows exactly what goes out, and nothing of the ticket.
  await card.getByRole("button", { name: "Review" }).click();
  const review = card.getByRole("group", { name: "Review" });
  await expect(review.locator("pre")).toHaveText(
    "Printer prints grey pages\n\nSteps to reproduce: print a test page.",
  );
  await review.getByRole("button", { name: "Publish issue" }).click();
  // The repository refuses; the draft stays and says so.
  await expect(card).toContainText("not published (http_404)");
  await expect(card.getByLabel("Title")).toHaveValue("Printer prints grey pages");
  // Searching a repository that does not answer names it.
  await panel.getByRole("searchbox", { name: "Search issues" }).fill("printer");
  await panel.getByRole("button", { name: "Search", exact: true }).last().click();
  await expect(panel.getByText(/acme\/app could not be read/)).toBeVisible();
  await card.getByRole("button", { name: "Discard draft" }).click();
  await expect(panel.locator(".issue-draft")).toHaveCount(0);
});
