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
test("exports an archived project and deletes it for good, as the owner", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const headers = { origin: baseURL ?? "" };
  const name = `Delete me ${desk.run}`;
  await signIn();
  // A project of its own, so that nothing of the fixture is lost.
  const created = await page.request.post("/api/v1/projects", {
    headers,
    data: { name, slug: `delete-${desk.run}`.toLowerCase(), defaultLanguage: "en" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const project = z.object({ id: z.string() }).parse(await created.json());
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page
    .locator("section.project-lifecycle")
    .filter({ has: page.getByRole("heading", { name: "Archive of projects" }) });
  await section.getByRole("button", { name: `Archive ${name}` }).click();
  await section.getByRole("button", { name: `Yes, archive ${name}` }).click();
  await expect(section.getByText(`${name} was archived.`)).toBeVisible();
  const entry = section
    .getByRole("listitem")
    .filter({ hasText: "Archived on" })
    .filter({ hasText: name });
  // The deletion is not offered before there is an export that was made after the archive.
  const remove = entry.getByRole("button", { name: `Delete ${name} for good` });
  await entry.getByLabel(`To delete ${name} for good, type its name`).fill(name);
  await expect(remove).toBeDisabled();
  await entry.getByRole("button", { name: `Export ${name}` }).click();
  await expect(section.getByText(`The export of ${name} was made.`)).toBeVisible();
  const link = entry.getByRole("link", { name: `Download the export of ${name}` });
  const file = await page.request.get((await link.getAttribute("href")) ?? "");
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("application/zip");
  expect((await file.body()).subarray(0, 2).toString()).toBe("PK");
  // The name has to be typed as it is.
  await entry.getByLabel(`To delete ${name} for good, type its name`).fill(`${name} `);
  await expect(remove).toBeDisabled();
  await entry.getByLabel(`To delete ${name} for good, type its name`).fill(name);
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(section.getByText(`${name} was deleted.`)).toBeVisible();
  const projects = z
    .array(z.object({ id: z.string() }))
    .parse(await (await page.request.get("/api/v1/projects?archived=include")).json());
  expect(projects.map((row) => row.id)).not.toContain(project.id);
  // The export is still there for the owner.
  expect((await page.request.get(`/api/v1/projects/${project.id}/exports`)).status()).toBe(200);
});
