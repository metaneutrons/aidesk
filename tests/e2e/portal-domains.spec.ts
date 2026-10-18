import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";
// The names of the customer page in the settings: a name is claimed, the record that proves it is shown, a
// look at the DNS finds nothing (the name belongs to no one here), and the claim is removed. A name is proved
// only by a record in a real DNS, so the test stops at the claim.
test.describe.configure({ mode: "serial" });
test("claims a name for the customer page, shows the record to create and removes the claim", async ({
  page,
  desk,
  signIn,
}) => {
  const { alpha } = desk.projects;
  const host = `claim-${desk.run}.example.test`.toLowerCase();
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page
    .locator("section.portal-domains")
    .filter({ has: page.getByRole("heading", { name: `Customer page names of ${alpha.name}` }) });
  await expect(section).toBeVisible();
  await expect(section.getByText("No name yet.")).toBeVisible();
  // Something that is not a name is refused and nothing is added.
  await section.getByLabel("Name, for example help.example.org").fill("not a name");
  await section.getByRole("button", { name: "Add name" }).click();
  await expect(section.getByText("That did not work.")).toBeVisible();
  await expect(section.getByText("No name yet.")).toBeVisible();
  await section.getByLabel("Name, for example help.example.org").fill(host.toUpperCase());
  await section.getByRole("button", { name: "Add name" }).click();
  await expect(section.getByText(`${host} was added.`)).toBeVisible();
  const entry = section.getByRole("listitem").filter({ hasText: host });
  await expect(entry.getByText("Waiting for the record")).toBeVisible();
  // The record that proves the name: its name and a value with the token of this claim.
  await expect(entry.locator("code").first()).toHaveText(`_aidesk-challenge.${host}`);
  await expect(entry.locator("code").nth(1)).toHaveText(/^aidesk-verify=[0-9a-f]{32}$/);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // Nobody has put the record into a DNS, so the name stays unproved.
  await entry.getByRole("button", { name: `Verify ${host}` }).click();
  await expect(section.getByText(/was not found yet/)).toBeVisible();
  await expect(entry.getByText("Waiting for the record")).toBeVisible();
  await entry.getByRole("button", { name: `Remove ${host}` }).click();
  await expect(section.getByText(`${host} was removed.`)).toBeVisible();
  await expect(section.getByText("No name yet.")).toBeVisible();
});
test("lets the owner claim a name for the whole installation and remove it", async ({
  page,
  desk,
  signIn,
}) => {
  const host = `wide-${desk.run}.example.test`.toLowerCase();
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.locator("section.portal-domains").filter({
    has: page.getByRole("heading", { name: "Customer page names of the installation" }),
  });
  await expect(section).toBeVisible();
  await section.getByLabel("Name, for example help.example.org").fill(host);
  await section.getByRole("button", { name: "Add name" }).click();
  await expect(section.getByText(`${host} was added.`)).toBeVisible();
  const entry = section.getByRole("listitem").filter({ hasText: host });
  await expect(entry.locator("code").first()).toHaveText(`_aidesk-challenge.${host}`);
  await entry.getByRole("button", { name: `Remove ${host}` }).click();
  await expect(section.getByText(`${host} was removed.`)).toBeVisible();
});
