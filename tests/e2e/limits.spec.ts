import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// The limits of the workspace in the settings: an owner changes one, saves, sees it after a reload, reads
// it over the API, and goes back to the standard. The value that is changed (the number of files of a
// received mail) is one that no other test depends on, and it is put back at the end.
test.describe.configure({ mode: "serial" });
// The limits belong to the whole installation, and the three browsers run side by side against one:
// one of them is enough to show the page, and none changes the limit under another.
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "The limits are global; one browser changes them.",
);
test("lets the owner change a limit, keeps it, and goes back to the standard", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page
    .locator("section.limits")
    .filter({ has: page.getByRole("heading", { name: "Limits of the workspace" }) });
  await expect(section).toBeVisible();
  const files = section.getByLabel("Files per received mail");
  try {
    await expect(files).toHaveValue("25");
    await expect(section.getByRole("button", { name: "Save limits" })).toBeDisabled();
    // A value outside its range cannot be saved.
    await files.fill("51");
    await expect(files).toHaveAttribute("aria-invalid", "true");
    await expect(section.getByRole("button", { name: "Save limits" })).toBeDisabled();
    await files.fill("24");
    await section.getByRole("button", { name: "Save limits" }).click();
    await expect(section.getByText("The limits were saved.")).toBeVisible();
    // It is kept: a new page load shows it, and so does the API.
    await page.reload();
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    await expect(section.getByLabel("Files per received mail")).toHaveValue("24");
    const stored = z
      .object({ intakeFiles: z.number(), sessionHours: z.number() })
      .parse(await (await page.request.get("/api/v1/workspace/limits")).json());
    expect(stored.intakeFiles).toBe(24);
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  } finally {
    await section.getByRole("button", { name: "Back to the standard" }).click();
    await expect(section.getByLabel("Files per received mail")).toHaveValue("25");
  }
  const back = z
    .object({ intakeFiles: z.number() })
    .parse(await (await page.request.get("/api/v1/workspace/limits")).json());
  expect(back.intakeFiles).toBe(25);
});
