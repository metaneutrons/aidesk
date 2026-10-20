import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, openSection, test } from "./fixtures";
// The usage of a project in the settings: the block is closed until it is opened, then it shows the AI, the mail and
// the storage, the period can be changed, and what is shown is what the API returns for that period.
const usageSchema = z.object({
  days: z.number(),
  from: z.string(),
  to: z.string(),
  mail: z.array(z.object({ day: z.string(), received: z.number(), sent: z.number() })),
  storage: z.object({ files: z.number(), bytes: z.number(), rawMails: z.number() }),
});
test("shows the usage of a project and changes its period", async ({ page, desk, signIn }) => {
  const { alpha } = desk.projects;
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page
    .locator("section.usage")
    .filter({ has: page.getByRole("heading", { name: `Usage of ${alpha.name}` }) });
  await expect(section).toBeVisible();
  // Nothing is read before the block is opened.
  await expect(section.getByRole("heading", { name: "Storage" })).toBeHidden();
  await openSection(section, `Usage of ${alpha.name}`);
  await expect(section.getByRole("heading", { name: "AI", exact: true })).toBeVisible();
  await expect(section.getByRole("heading", { name: "Mail", exact: true })).toBeVisible();
  await expect(
    section.getByText(/files \(.* MB\) and .* received mails are stored\./),
  ).toBeVisible();
  const asked = async (days: number) =>
    usageSchema.parse(
      await (
        await page.request.get(`/api/v1/projects/${alpha.id}/usage?days=${String(days)}`)
      ).json(),
    );
  const fortnight = await asked(14);
  expect(fortnight.days).toBe(14);
  // The stored files and the mails of the first day shown are those of the API.
  const stored = fortnight.storage;
  await expect(
    section.getByText(
      new RegExp(
        `^${stored.files.toLocaleString("en")} files \\(.* MB\\) and ${stored.rawMails.toLocaleString("en")} received mails are stored\\.$`,
      ),
    ),
  ).toBeVisible();
  const first = fortnight.mail[0];
  if (first) {
    const row = section.getByRole("row").filter({ hasText: first.day }).last();
    await expect(row).toContainText(String(first.received));
  }
  // A shorter period asks again, and the API gives the window that the page names.
  const reread = page.waitForResponse((response) => response.url().endsWith("/usage?days=7"));
  await section.getByLabel("Period").selectOption({ label: "Last 7 days" });
  const week = usageSchema.parse(await (await reread).json());
  expect(week.days).toBe(7);
  expect(week.from < week.to).toBe(true);
  expect(week.mail.length).toBeLessThanOrEqual(fortnight.mail.length);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // A period outside 1 to 90 days is refused by the API.
  const refused = await page.request.get(`/api/v1/projects/${alpha.id}/usage?days=91`);
  expect(refused.status()).toBe(400);
});
