import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// The profile of the signed-in operator in the settings: the name and the signature are saved, kept after a reload,
// read over the API, and removed again. The fixture operator is the only one who changes it, and it is put back.
test.describe.configure({ mode: "serial" });
const profileSchema = z.object({
  displayName: z.string().nullable(),
  signature: z.string().nullable(),
});
test("saves the name and the signature of the operator and removes them again", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page
    .locator("section.profile")
    .filter({ has: page.getByRole("heading", { name: "Your profile" }) });
  await expect(section).toBeVisible();
  const save = section.getByRole("button", { name: "Save profile" });
  try {
    await expect(save).toBeDisabled();
    await section.getByLabel("Name on replies").fill("Kim Example");
    await section.getByLabel("Signature").fill("Kim Example\nSupport team");
    await save.click();
    await expect(section.getByText("The profile was saved.")).toBeVisible();
    await expect(save).toBeDisabled();
    await page.reload();
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    await expect(section.getByLabel("Name on replies")).toHaveValue("Kim Example");
    await expect(section.getByLabel("Signature")).toHaveValue("Kim Example\nSupport team");
    const stored = profileSchema.parse(await (await page.request.get("/api/v1/me/profile")).json());
    expect(stored).toEqual({ displayName: "Kim Example", signature: "Kim Example\nSupport team" });
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  } finally {
    await section.getByLabel("Name on replies").fill("");
    await section.getByLabel("Signature").fill("");
    if (await save.isEnabled()) await save.click();
  }
  await expect(section.getByText("The profile was saved.")).toBeVisible();
  const back = profileSchema.parse(await (await page.request.get("/api/v1/me/profile")).json());
  expect(back).toEqual({ displayName: null, signature: null });
});
