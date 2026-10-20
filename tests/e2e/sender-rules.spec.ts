import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// The lists of senders in the settings: an address and a domain are blocked, a bad entry and a double one are
// refused with a reason, and an entry is taken off again. The test leaves the lists as it found them.
test.describe.configure({ mode: "serial" });
const rulesSchema = z.array(z.object({ id: z.string(), kind: z.string(), value: z.string() }));
test("blocks and allows senders and takes them off again", async ({ page, desk, signIn }) => {
  const { alpha } = desk.projects;
  const domain = `blocked-${desk.run}.example.test`.toLowerCase();
  const address = `kim@allowed-${desk.run}.example.test`.toLowerCase();
  const rules = async () =>
    rulesSchema.parse(
      await (await page.request.get(`/api/v1/projects/${alpha.id}/sender-rules`)).json(),
    );
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.locator("section.sender-rules").filter({
    has: page.getByRole("heading", { name: `Allowed and blocked senders for ${alpha.name}` }),
  });
  await expect(section).toBeVisible();
  try {
    await section.getByLabel("Address or domain").fill(`  @${domain.toUpperCase()} `);
    await section.locator("select").selectOption("block");
    await section.getByLabel("Note (optional)").fill("Newsletter");
    await section.getByRole("button", { name: "Add", exact: true }).click();
    const item = section.getByRole("listitem").filter({ hasText: domain });
    await expect(item).toContainText("Block");
    await expect(item).toContainText("Newsletter");
    await section.getByLabel("Address or domain").fill(address);
    await section.locator("select").selectOption("allow");
    await section.getByRole("button", { name: "Add", exact: true }).click();
    await expect(section.getByRole("listitem").filter({ hasText: address })).toContainText("Allow");
    expect((await rules()).map((rule) => [rule.kind, rule.value])).toEqual(
      expect.arrayContaining([
        ["block", domain],
        ["allow", address],
      ]),
    );
    // A name that is no address or domain, and one that is listed already, are refused with a reason.
    await section.getByLabel("Address or domain").fill("not a name");
    await section.getByRole("button", { name: "Add", exact: true }).click();
    await expect(section.getByRole("alert")).toContainText("Enter an address like kim@example.org");
    await section.getByLabel("Address or domain").fill(domain);
    await section.getByRole("button", { name: "Add", exact: true }).click();
    await expect(section.getByRole("alert")).toContainText("already listed");
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
    await section.getByRole("button", { name: `Remove ${domain} from the list` }).click();
    await expect(section.getByRole("listitem").filter({ hasText: domain })).toHaveCount(0);
    expect((await rules()).some((rule) => rule.value === domain)).toBe(false);
  } finally {
    for (const rule of await rules())
      if ([domain, address].includes(rule.value))
        await page.request.post(`/api/v1/projects/${alpha.id}/sender-rules/${rule.id}/delete`);
  }
});
