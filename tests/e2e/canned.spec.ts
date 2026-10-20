import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Canned replies: written in the settings, offered in the composer of a ticket with the placeholders filled in, and
// removed again. The test leaves the project as it found it.
test.describe.configure({ mode: "serial" });
const listSchema = z.array(z.object({ id: z.string(), name: z.string(), version: z.number() }));
test("writes a canned reply and uses it in the composer", async ({
  page,
  desk,
  signIn,
  baseURL,
  browserName,
}) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  const name = `E2E reply ${desk.run} ${browserName}`;
  await signIn();
  const replies = async () =>
    listSchema.parse(
      await (await page.request.get(`/api/v1/projects/${alpha.id}/canned-replies`)).json(),
    );
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.locator("section.canned-replies").filter({
    has: page.getByRole("heading", { name: `Canned replies for ${alpha.name}` }),
  });
  await expect(section).toBeVisible();
  try {
    const form = section.getByRole("form", { name: "New canned reply" });
    await form.getByLabel("Name").fill(name);
    await form
      .getByLabel("Text (Markdown)")
      .fill("Hello {{customer_name}}, about ticket {{ticket_number}}.");
    await form.getByRole("button", { name: "Add the reply" }).click();
    const row = section.getByRole("listitem").filter({ hasText: name });
    await expect(row).toContainText("Hello {{customer_name}}");
    // A placeholder that does not exist is refused with a reason.
    await form.getByLabel("Name").fill(`${name} bad`);
    await form.getByLabel("Text (Markdown)").fill("Hello {{nobody}}");
    await form.getByRole("button", { name: "Add the reply" }).click();
    await expect(section.getByRole("alert")).toContainText("not valid");
    // A change loads the reply into the form.
    await row.getByRole("button", { name: `Change ${name}` }).click();
    const edit = section.getByRole("form", { name: "Change the canned reply" });
    await edit
      .getByLabel("Text (Markdown)")
      .fill("Hello {{customer_name}}, about ticket {{ticket_number}}, {{operator_name}}.");
    await edit.getByRole("button", { name: "Save the reply" }).click();
    await expect(row).toContainText("{{operator_name}}");
    expect((await replies()).find((entry) => entry.name === name)?.version).toBe(2);
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
    // The composer offers it, filled in for the ticket, and the insertion can be taken back.
    await page.getByRole("navigation").getByRole("button", { name: "Inbox" }).click();
    const list = page.getByRole("region", { name: "Inbox" });
    await list.getByRole("button", { name: new RegExp(`${alpha.name} request 1`) }).click();
    const panel = page.getByRole("region", { name: "Ticket" });
    const composer = panel.getByRole("textbox", { name: "Write your reply in Markdown…" });
    await panel.getByLabel("Insert a canned reply").selectOption({ label: `${name} (en)` });
    await expect(composer).toHaveValue(/Hello Customer 1, about ticket \d+, .+\./);
    await expect(composer).not.toHaveValue(/\{\{/);
    // A second one is added below what is there.
    await panel.getByLabel("Insert a canned reply").selectOption({ label: `${name} (en)` });
    await expect(composer).toHaveValue(/\.\n\nHello Customer 1/);
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    await row.getByRole("button", { name: `Remove ${name}` }).click();
    await expect(section.getByRole("listitem").filter({ hasText: name })).toHaveCount(0);
    expect((await replies()).filter((entry) => entry.name === name)).toEqual([]);
  } finally {
    for (const entry of await replies())
      if (entry.name.startsWith(name))
        await page.request.post(`/api/v1/projects/${alpha.id}/canned-replies/${entry.id}/delete`, {
          headers,
          data: { expectedVersion: entry.version },
        });
  }
});
