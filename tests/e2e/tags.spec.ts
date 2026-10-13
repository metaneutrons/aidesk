import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Tags: the team's own labels on tickets, with a filter over the list.
test.describe.configure({ mode: "serial" });
test("tags a ticket, filters the list by tag and keeps the open draft", async ({
  page,
  desk,
  signIn,
}) => {
  const { alpha } = desk.projects;
  // A short window makes the message list scroll, which the scan must accept.
  await page.setViewportSize({ width: 1280, height: 560 });
  await signIn();
  await page.goto("/");
  const list = page.getByRole("region", { name: "Inbox" });
  await page.getByRole("navigation").getByRole("button", { name: "Inbox" }).click();
  await list.getByRole("button", { name: new RegExp(`${alpha.name} request 1`) }).click();
  const panel = page.getByRole("region", { name: "Ticket" });
  await panel.getByRole("textbox", { name: "Write your reply in Markdown…" }).fill("Draft stays");
  // The input shows what is accepted: a spelling is normalized, not refused.
  await panel.getByRole("combobox", { name: "Add tag" }).fill("Needs Review");
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(panel.getByRole("list", { name: "Tags" }).getByText("needs-review")).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Write your reply in Markdown…" })).toHaveValue(
    "Draft stays",
  );
  // An invalid tag cannot be added.
  await panel.getByRole("combobox", { name: "Add tag" }).fill("-bad");
  await expect(panel.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await expect(panel.getByText(/Letters, digits, hyphen/)).toBeVisible();
  await panel.getByRole("combobox", { name: "Add tag" }).fill("");
  // The tag is on the row and offers a filter that leaves only that ticket.
  await expect(list.getByText("needs-review").first()).toBeVisible();
  const filter = list.getByRole("group", { name: "Filter by tag" });
  await filter.getByRole("button", { name: /needs-review/ }).click();
  await expect(list.getByText(/^1 ticket/)).toBeVisible();
  await expect(
    list.getByRole("button", { name: new RegExp(`${alpha.name} request 2`) }),
  ).toHaveCount(0);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  await filter.getByRole("button", { name: "All tags" }).click();
  // Removing it clears the filter option, and the API agrees with the screen.
  await panel.getByRole("button", { name: "Remove tag needs-review" }).click();
  await expect(panel.getByRole("list", { name: "Tags" }).getByText("needs-review")).toHaveCount(0);
  const detail = z
    .object({ ticket: z.object({ tags: z.array(z.string()), revision: z.number() }) })
    .parse(await (await page.request.get(`/api/v1/tickets/${alpha.tickets[0]}`)).json());
  expect(detail.ticket.tags).toEqual([]);
});
