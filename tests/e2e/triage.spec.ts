import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Priority and category: set in the ticket header, shown in the list and used as filters. The categories come from
// the configuration of the project, which the test sets and puts back.
test.describe.configure({ mode: "serial" });
const configSchema = z.object({ version: z.number(), config: z.record(z.string(), z.unknown()) });
const ticketSchema = z.object({
  ticket: z.object({ priority: z.string(), category: z.string().nullable() }),
});
test("sets the priority and the category of a ticket and filters by them", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  await signIn();
  const read = async () =>
    configSchema.parse(
      await (await page.request.get(`/api/v1/projects/${alpha.id}/config`)).json(),
    );
  const original = await read();
  const write = async (config: Record<string, unknown>) => {
    const now = await read();
    return page.request.put(`/api/v1/projects/${alpha.id}/config`, {
      headers,
      data: { config, expectedVersion: now.version },
    });
  };
  const detail = async () =>
    ticketSchema.parse(await (await page.request.get(`/api/v1/tickets/${alpha.tickets[0]}`)).json())
      .ticket;
  try {
    expect(
      (await write({ ...original.config, categories: "E2E Billing\nE2E Technical" })).ok(),
    ).toBe(true);
    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "Inbox" }).click();
    const list = page.getByRole("region", { name: "Inbox" });
    await list.getByRole("button", { name: new RegExp(`${alpha.name} request 1`) }).click();
    const panel = page.getByRole("region", { name: "Ticket" });
    const group = panel.getByRole("group", { name: "Priority and category" });
    await expect(group.getByLabel("Priority")).toHaveValue("normal");
    await group.getByLabel("Priority").selectOption("urgent");
    await expect.poll(async () => (await detail()).priority).toBe("urgent");
    await group.getByLabel("Category").selectOption("E2E Billing");
    await expect.poll(async () => (await detail()).category).toBe("E2E Billing");
    // The list shows both, and the filters narrow it to this ticket.
    const row = list.getByRole("button", { name: new RegExp(`${alpha.name} request 1`) });
    await expect(row.getByText("Urgent")).toBeVisible();
    await expect(row.getByText("E2E Billing")).toBeVisible();
    const other = list.getByRole("button", { name: new RegExp(`${alpha.name} request 2`) });
    await expect(other).toBeVisible();
    const filter = list.getByRole("group", { name: "Filter by priority and category" });
    await filter.getByLabel("Priority").selectOption("urgent");
    await expect(other).toHaveCount(0);
    await expect(row).toBeVisible();
    await filter.getByLabel("Priority").selectOption("");
    await filter.getByLabel("Category").selectOption("E2E Technical");
    await expect(row).toHaveCount(0);
    await filter.getByLabel("Category").selectOption("");
    await expect(row).toBeVisible();
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
    // The category can be taken off again.
    await group.getByLabel("Category").selectOption("");
    await expect.poll(async () => (await detail()).category).toBeNull();
    // A category off the list is refused by the API, with a reason that is not the rights.
    const refused = await page.request.post(`/api/v1/tickets/${alpha.tickets[0]}/triage`, {
      headers,
      data: { category: "E2E Gossip" },
    });
    expect(refused.status()).toBe(400);
  } finally {
    await page.request.post(`/api/v1/tickets/${alpha.tickets[0]}/triage`, {
      headers,
      data: { priority: "normal", category: null },
    });
    await write(original.config);
  }
});
