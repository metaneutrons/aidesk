import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// The administration of tags in the settings: a tag is renamed, merged into another, coloured and removed after the
// question. Two tickets carry the tags, and the test takes them off again. The tickets are shared by the browsers of
// a run, so this one runs in one browser only.
test.describe.configure({ mode: "serial" });
const listSchema = z.array(
  z.object({ tag: z.string(), tickets: z.number(), color: z.string().nullable() }),
);
test("renames, merges, colours and removes tags", async ({
  page,
  desk,
  signIn,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "The tickets are shared by the browsers of a run");
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  const tag = (name: string) => `e2e-${desk.run}-${name}`;
  await signIn();
  const tags = async () =>
    listSchema.parse(
      await (await page.request.get(`/api/v1/projects/${alpha.id}/tag-admin`)).json(),
    );
  const setTags = async (ticket: string | undefined, values: string[]) =>
    page.request.post(`/api/v1/tickets/${ticket ?? ""}/tags`, { headers, data: { tags: values } });
  try {
    expect((await setTags(alpha.tickets[0], [tag("one"), tag("two")])).ok()).toBe(true);
    expect((await setTags(alpha.tickets[1], [tag("one")])).ok()).toBe(true);
    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    const section = page.locator("section.tag-admin").filter({
      has: page.getByRole("heading", { name: `Tags of ${alpha.name}` }),
    });
    await expect(section).toBeVisible();
    // A row is found by its chip: the lists of the merge selects carry the names of the other rows too.
    const row = (name: string) =>
      section
        .getByRole("listitem")
        .filter({ has: page.locator("span.tag-chip", { hasText: new RegExp(`^${name}$`) }) });
    await expect(row(tag("one"))).toContainText("2 tickets");
    // A colour is set for the chips.
    await row(tag("one"))
      .getByLabel(`Colour of ${tag("one")}`)
      .fill("#aa0000");
    await expect
      .poll(async () => (await tags()).find((entry) => entry.tag === tag("one"))?.color)
      .toBe("#aa0000");
    // Renaming loads a form; a name in use is refused with a reason.
    await row(tag("two"))
      .getByRole("button", { name: `Rename ${tag("two")}` })
      .click();
    const form = section.getByRole("form", { name: `Rename the tag ${tag("two")}` });
    await form.getByLabel("New name").fill(tag("one"));
    await form.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(section.getByRole("alert")).toContainText("The name is in use");
    await form.getByLabel("New name").fill(tag("three"));
    await form.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(row(tag("three"))).toContainText("1 ticket");
    await expect(row(tag("two"))).toHaveCount(0);
    // Merging puts the tickets of one tag into the other.
    await row(tag("three"))
      .getByLabel(`Merge ${tag("three")} into`)
      .selectOption(tag("one"));
    await expect(row(tag("three"))).toHaveCount(0);
    await expect(row(tag("one"))).toContainText("2 tickets");
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
    // Removing asks first, with the number of tickets, and can be called off.
    await row(tag("one"))
      .getByRole("button", { name: `Remove ${tag("one")}` })
      .click();
    await expect(row(tag("one")).getByRole("alert")).toContainText("Remove");
    await expect(row(tag("one")).getByRole("alert")).toContainText("2 tickets");
    await row(tag("one")).getByRole("button", { name: "Cancel" }).click();
    expect((await tags()).some((entry) => entry.tag === tag("one"))).toBe(true);
    await row(tag("one"))
      .getByRole("button", { name: `Remove ${tag("one")}` })
      .click();
    await row(tag("one"))
      .getByRole("button", { name: `Yes, remove ${tag("one")}` })
      .click();
    await expect(row(tag("one"))).toHaveCount(0);
    expect((await tags()).some((entry) => entry.tag.startsWith(`e2e-${desk.run}`))).toBe(false);
  } finally {
    await setTags(alpha.tickets[0], []);
    await setTags(alpha.tickets[1], []);
    for (const name of ["one", "two", "three"])
      await page.request.post(`/api/v1/projects/${alpha.id}/tag-admin/color`, {
        headers,
        data: { tag: tag(name), color: null },
      });
  }
});
