import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Archiving a project in the settings: it is archived on a second click, it disappears from the list of the
// projects and appears under the archived ones, and it is restored. The project is restored in any case.
test.describe.configure({ mode: "serial" });
test("archives a project, lists it as archived and restores it", async ({ page, desk, signIn }) => {
  const { alpha } = desk.projects;
  const listed = async (query: string) =>
    z
      .array(z.object({ id: z.string(), archivedAt: z.string().nullable() }))
      .parse(await (await page.request.get(`/api/v1/projects${query}`)).json());
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page
    .locator("section.project-lifecycle")
    .filter({ has: page.getByRole("heading", { name: "Archive of projects" }) });
  await expect(section).toBeVisible();
  try {
    await section.getByRole("button", { name: `Archive ${alpha.name}` }).click();
    // A question comes first, and nothing is archived by the first click.
    await expect(section.getByText("Archive this project?")).toBeVisible();
    expect((await listed("")).map((project) => project.id)).toContain(alpha.id);
    await section.getByRole("button", { name: "Cancel" }).click();
    await section.getByRole("button", { name: `Archive ${alpha.name}` }).click();
    await section.getByRole("button", { name: `Yes, archive ${alpha.name}` }).click();
    await expect(section.getByText(`${alpha.name} was archived.`)).toBeVisible();
    const archived = section.getByRole("listitem").filter({ hasText: "Archived on" });
    await expect(archived.filter({ hasText: alpha.name })).toBeVisible();
    expect((await listed("")).map((project) => project.id)).not.toContain(alpha.id);
    expect((await listed("?archived=only")).map((project) => project.id)).toEqual([alpha.id]);
    expect((await listed("?archived=include")).map((project) => project.id)).toContain(alpha.id);
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  } finally {
    const restore = section.getByRole("button", { name: `Restore ${alpha.name}` });
    if (await restore.isVisible()) await restore.click();
    else
      await page.request.post(`/api/v1/projects/${alpha.id}/restore`, {
        headers: { origin: new URL(page.url()).origin },
        data: {},
      });
  }
  await expect(section.getByText(`${alpha.name} was restored.`)).toBeVisible();
  expect((await listed("")).map((project) => project.id)).toContain(alpha.id);
  expect(await listed("?archived=only")).toEqual([]);
});
