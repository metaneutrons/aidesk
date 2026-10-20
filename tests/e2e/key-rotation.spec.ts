import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// The keys of the installation, as the owner sees them: with no previous key set nothing is being rotated, the status
// lists the groups of stored values, and the run is refused until an operator has set a previous key.
const statusSchema = z.object({
  encryptionPrevious: z.boolean(),
  authPrevious: z.boolean(),
  groups: z.array(z.object({ name: z.string(), total: z.number(), unreadable: z.number() })),
  settled: z.boolean(),
});
test("shows the keys of the installation to the owner and refuses a run without a previous key", async ({
  page,
  signIn,
  baseURL,
}) => {
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.locator("section.key-rotation");
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { name: "Keys of the installation" })).toBeVisible();
  await expect(
    section.getByRole("button", { name: "Re-protect with the current keys" }),
  ).toBeVisible();
  await expect(section.getByText("Secrets of connections")).toBeVisible();
  await expect(section.getByText("Authenticator and backup codes of the owners")).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  const status = statusSchema.parse(
    await (await page.request.get("/api/v1/workspace/keys")).json(),
  );
  expect(status).toMatchObject({ encryptionPrevious: false, authPrevious: false });
  expect(status.groups.map((group) => group.name)).toEqual([
    "connections",
    "webhooks",
    "sso",
    "proposals",
    "owner_factors",
    "owner_claims",
  ]);
  // Without a previous key a run is refused when nothing is left to re-protect, and runs when something is.
  const run = await page.request.post("/api/v1/workspace/keys/rotate", {
    headers: { origin: baseURL ?? "" },
  });
  expect(run.status()).toBe(status.settled ? 409 : 200);
});
