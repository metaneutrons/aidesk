import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Reminders: a time at which the team wants to see a ticket again.
test.describe.configure({ mode: "serial" });
test("sets reminders, shows what is due and keeps the open draft", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  await signIn();
  // One reminder that is due already, set through the API.
  const past = new Date(Date.now() - 3_600_000).toISOString();
  expect(
    (
      await page.request.post(`/api/v1/tickets/${alpha.tickets[0]}/reminder`, {
        data: { remindAt: past },
        headers,
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/");
  const metric = page.getByRole("button", { name: /Reminders due/ });
  await expect(metric.getByText("1", { exact: true })).toBeVisible();
  await metric.click();
  const list = page.getByRole("region", { name: "Inbox" });
  await expect(
    list.getByRole("button", { name: new RegExp(`${alpha.name} request 1`) }),
  ).toBeVisible();
  await expect(list.getByText(/Reminder due/)).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // Opening it shows the state, and "Done" clears it.
  await list.getByRole("button", { name: new RegExp(`${alpha.name} request 1`) }).click();
  const panel = page.getByRole("region", { name: "Ticket" });
  await expect(panel.getByText(/Reminder due since/)).toBeVisible();
  await panel.getByRole("button", { name: "Done" }).click();
  await expect(panel.getByText(/Reminder due since/)).toHaveCount(0);
  await page.getByRole("navigation").getByRole("button", { name: "Reminders" }).click();
  await expect(
    list.getByRole("button", { name: new RegExp(`${alpha.name} request 1`) }),
  ).toHaveCount(0);
  // A reminder set in the ticket does not disturb a draft that is being written.
  await page.getByRole("navigation").getByRole("button", { name: "Inbox" }).click();
  await list.getByRole("button", { name: new RegExp(`${alpha.name} request 2`) }).click();
  await panel.getByRole("textbox", { name: "Write your reply in Markdown…" }).fill("Draft stays");
  await panel.getByRole("button", { name: "Tomorrow 9:00" }).click();
  await expect(panel.getByText(/^Reminder: /)).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Write your reply in Markdown…" })).toHaveValue(
    "Draft stays",
  );
  const detail = z
    .object({ ticket: z.object({ remindAt: z.string().nullable(), revision: z.number() }) })
    .parse(await (await page.request.get(`/api/v1/tickets/${alpha.tickets[1]}`)).json());
  expect(detail.ticket.remindAt).not.toBeNull();
  // It is listed, not due, and can be cleared.
  await page.getByRole("navigation").getByRole("button", { name: "Reminders" }).click();
  await expect(
    list.getByRole("button", { name: new RegExp(`${alpha.name} request 2`) }),
  ).toBeVisible();
  await expect(metric).toHaveCount(0);
  await page.getByRole("navigation").getByRole("button", { name: "Inbox" }).click();
  await list.getByRole("button", { name: new RegExp(`${alpha.name} request 2`) }).click();
  await panel.getByRole("button", { name: "Clear reminder" }).click();
  await expect(panel.getByText(/^Reminder: /)).toHaveCount(0);
});
