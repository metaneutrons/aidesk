import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// The overview of where ticket content goes: the page lists the connections and the models of the project, and the
// same list can be taken out as a file, which is an entry of the audit.
test("shows where the content of the tickets goes and exports it", async ({
  page,
  desk,
  signIn,
}) => {
  const { alpha } = desk.projects;
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.locator("section.processing").filter({
    has: page.getByRole("heading", { name: `Processing of ticket content for ${alpha.name}` }),
  });
  await expect(section).toBeVisible();
  // Every task of a model is listed, whether it is set up or not.
  await expect(section.getByRole("heading", { name: "Models by task" })).toBeVisible();
  await expect(section.getByText("Draft a reply to the customer")).toBeVisible();
  await expect(section.getByText("Tell junk from support mail")).toBeVisible();
  await expect(section.getByRole("heading", { name: "Outgoing mail" })).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // The file is the same list, and taking it out is written to the audit.
  const link = section.getByRole("link", { name: "Export as a CSV file" });
  await expect(link).toHaveAttribute("href", `/api/v1/projects/${alpha.id}/processing/export`);
  const file = await page.request.get(`/api/v1/projects/${alpha.id}/processing/export`);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("text/csv");
  expect((await file.text()).split("\r\n")[0]).toBe(
    "group,name,kind,task,host,detail,receives,state,issues",
  );
  const entries = z
    .object({ entries: z.array(z.object({ action: z.string() })) })
    .parse(
      await (
        await page.request.get(`/api/v1/projects/${alpha.id}/audit?action=processing.export`)
      ).json(),
    );
  expect(entries.entries.some((entry) => entry.action === "processing.export")).toBe(true);
});
