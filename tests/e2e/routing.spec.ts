import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// The routing of new tickets in the settings: rules are added, put in order, changed, switched off and removed. The
// test leaves the rules of the project as it found them.
test.describe.configure({ mode: "serial" });
const rulesSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    priority: z.string().nullable(),
    target: z.object({ kind: z.string() }).nullable(),
    conditions: z.object({ subjectWords: z.array(z.string()) }),
  }),
);
test("adds, orders, changes and removes routing rules", async ({ page, desk, signIn, baseURL }) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  const first = `E2E first ${desk.run}`;
  const second = `E2E second ${desk.run}`;
  await signIn();
  const rules = async () =>
    rulesSchema.parse(
      await (await page.request.get(`/api/v1/projects/${alpha.id}/routing-rules`)).json(),
    );
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.locator("section.routing-rules").filter({
    has: page.getByRole("heading", { name: `Routing of new tickets for ${alpha.name}` }),
  });
  await expect(section).toBeVisible();
  try {
    const form = section.getByRole("form", { name: "New rule" });
    await form.getByLabel("Name of the rule").fill(first);
    await form.getByLabel("Words in the subject").fill("invoice, refund");
    await form.getByLabel("Assign to").selectOption({ index: 1 });
    await form.getByLabel("Priority").selectOption("high");
    await form.getByRole("button", { name: "Add the rule" }).click();
    const firstRow = section.getByRole("listitem").filter({ hasText: first });
    await expect(firstRow).toContainText("invoice, refund");
    await expect(firstRow).toContainText("High");
    // A rule without conditions is the default; it is added last.
    await form.getByLabel("Name of the rule").fill(second);
    await form.getByLabel("Priority").selectOption("low");
    await form.getByRole("button", { name: "Add the rule" }).click();
    const secondRow = section.getByRole("listitem").filter({ hasText: second });
    await expect(secondRow).toContainText("Every ticket");
    expect((await rules()).map((rule) => rule.name)).toEqual(
      expect.arrayContaining([first, second]),
    );
    // Moving the second rule up puts it before the first.
    await secondRow.getByRole("button", { name: `Move ${second} up` }).click();
    await expect
      .poll(async () =>
        (await rules()).map((rule) => rule.name).filter((name) => name.includes(desk.run)),
      )
      .toEqual([second, first]);
    // Changing a rule loads it into the form; saving replaces it.
    await secondRow.getByRole("button", { name: `Change ${second}` }).click();
    const editForm = section.getByRole("form", { name: "Change the rule" });
    await expect(editForm.getByLabel("Name of the rule")).toHaveValue(second);
    await editForm.getByLabel("Priority").selectOption("urgent");
    await editForm.getByRole("button", { name: "Save the rule" }).click();
    await expect(secondRow).toContainText("Urgent");
    // Switched off, a rule stays in the list and is marked.
    await firstRow.getByRole("button", { name: `Switch ${first} off` }).click();
    await expect(firstRow).toContainText("switched off");
    expect((await rules()).find((rule) => rule.name === first)?.enabled).toBe(false);
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
    await firstRow.getByRole("button", { name: `Remove ${first}` }).click();
    await expect(firstRow).toHaveCount(0);
    // A rule that names nothing to do cannot be added from the form, and the API refuses it as well.
    await expect(section.getByRole("button", { name: "Add the rule" })).toBeDisabled();
    const refused = await page.request.post(`/api/v1/projects/${alpha.id}/routing-rules`, {
      headers,
      data: { name: "Nothing" },
    });
    expect(refused.status()).toBe(400);
  } finally {
    for (const rule of await rules())
      if ([first, second].includes(rule.name))
        await page.request.post(`/api/v1/projects/${alpha.id}/routing-rules/${rule.id}/delete`, {
          headers,
        });
  }
});
