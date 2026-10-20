import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// The export about a requester from the settings: the file is downloaded, and the export is an entry of the audit
// that holds a digest of the address and not the address.
test("takes out what is held about a requester as a file", async ({ page, desk, signIn }) => {
  const { alpha } = desk.projects;
  const address = `${desk.prefix}-nobody-${Date.now().toString(36)}@example.test`;
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.locator("section.requester-export").filter({
    has: page.getByRole("heading", { name: `Export about a requester in ${alpha.name}` }),
  });
  await expect(section).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // A word that is no address is refused, and the button waits for something to export.
  await expect(section.getByRole("button", { name: "Export what is held" })).toBeDisabled();
  await section.getByLabel("Address of the requester").fill(address);
  const download = page.waitForEvent("download");
  await section.getByRole("button", { name: "Export what is held" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^requester-[a-f0-9]{12}-\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(section.getByRole("status")).toContainText("The file was downloaded");
  const entries = z
    .object({
      entries: z.array(z.object({ action: z.string(), detail: z.record(z.string(), z.unknown()) })),
    })
    .parse(
      await (
        await page.request.get(`/api/v1/projects/${alpha.id}/audit?action=requester.export`)
      ).json(),
    );
  const written = entries.entries.find((entry) => entry.action === "requester.export");
  expect(written).toBeDefined();
  expect(JSON.stringify(written)).not.toContain(address);
  expect(String(written?.detail.requester)).toMatch(/^[a-f0-9]{64}$/);
});
