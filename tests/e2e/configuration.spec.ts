import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Project configuration: one document, saved as a whole, with changes by agents
// waiting for approval under the default policy.
test.describe.configure({ mode: "serial" });
test("edits the configuration, checks it first, and approves what an agent proposes", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  await signIn();
  const read = async () =>
    z
      .object({ version: z.number(), config: z.record(z.string(), z.unknown()) })
      .parse(await (await page.request.get(`/api/v1/projects/${alpha.id}/config`)).json());
  // The browsers of one run share the project, so the test leaves it as it found it.
  const original = (await read()).config;
  try {
    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    const section = page.getByRole("region", { name: `Configuration of ${String(original.name)}` });
    await expect(section).toBeVisible();
    // The check reports the difference and writes nothing.
    const renamed = `${String(original.name)} renamed`;
    await section.getByLabel("Name").fill(renamed);
    // The warning limit is its own field; it is saved with the name.
    await section.getByLabel("Warn after (hours)").fill("3");
    // What a reply to a resolved ticket does is a field too; the window is only open for reopening.
    await section.getByLabel("A reply to a resolved ticket").selectOption("refuse");
    await expect(section.getByLabel("Window for reopening in days")).toBeDisabled();
    await section.getByLabel("A reply to a resolved ticket").selectOption("reopen");
    await section.getByLabel("Window for reopening in days").fill("14");
    // The reminder of the automatic resolve is open only when there are days to resolve in.
    await expect(section.getByLabel("Remind the customer days before")).toBeDisabled();
    await section.getByLabel("Resolve a waiting ticket after days without an answer").fill("10");
    await section.getByLabel("Remind the customer days before").fill("3");
    // How far the headers of a mail count for junk.
    await section.getByLabel("Junk detection by the headers of a mail").selectOption("strict");
    // Limits by priority and the list of categories.
    await section.getByLabel("Urgent priority: warn after").fill("1");
    await section.getByLabel("Urgent priority: overdue after").fill("2");
    await section.getByLabel("Categories of tickets (one per line)").fill("Billing\nSupport");
    // Business hours: the fields are open once they are switched on, and the form cannot be saved incomplete.
    await expect(section.getByLabel("Time zone of the business hours")).toBeDisabled();
    await section.getByLabel("The response clock runs only within business hours").check();
    await section.getByLabel("Time zone of the business hours").fill("Europe/Berlin");
    await section.getByLabel("Business hours start").fill("08:00");
    await section.getByLabel("Business hours end").fill("16:30");
    await section.getByLabel("Friday").uncheck();
    await section.getByLabel(/^Holidays without business hours/).fill("2026-12-25\n2026-12-26");
    await section.getByLabel("Time zone of the business hours").fill("Mars/Base");
    await expect(section.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(section.getByText("The configuration is not valid.")).toBeVisible();
    await section.getByLabel("Time zone of the business hours").fill("Europe/Berlin");
    await section.getByRole("button", { name: "Check" }).click();
    await expect(section.getByRole("list", { name: "Changes" })).toContainText(
      `name: ${String(original.name)} → ${renamed}`,
    );
    expect((await read()).config.name).toBe(original.name);
    await section.getByRole("button", { name: "Save", exact: true }).click();
    await expect(section.getByText("Saved.")).toBeVisible();
    expect((await read()).config.name).toBe(renamed);
    expect((await read()).config.warnHours).toBe(3);
    expect((await read()).config).toMatchObject({
      reopenMode: "reopen",
      reopenDays: 14,
      autoResolveDays: 10,
      autoResolveReminderDays: 3,
      junkSensitivity: "strict",
      warnHoursUrgent: 1,
      overdueHoursUrgent: 2,
      categories: "Billing\nSupport",
      businessDays: "1,2,3,4",
      businessStart: "08:00",
      businessEnd: "16:30",
      businessTimeZone: "Europe/Berlin",
      holidays: "2026-12-25,2026-12-26",
    });
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
    // An agent with config rights proposes; nothing changes until a person approves.
    const issued = z.object({ token: z.string() }).parse(
      await (
        await page.request.post(`/api/v1/projects/${alpha.id}/agents`, {
          headers,
          data: {
            name: "Configurator",
            actions: ["project.read", "config.read", "config.write"],
          },
        })
      ).json(),
    );
    const before = await read();
    const proposal = await page.request.put(`/api/v1/projects/${alpha.id}/config`, {
      headers: { authorization: `Bearer ${issued.token}` },
      data: {
        config: { ...before.config, acknowledgements: true },
        expectedVersion: before.version,
      },
    });
    expect(proposal.status()).toBe(202);
    expect((await read()).config.acknowledgements).toBe(before.config.acknowledgements);
    await page.reload();
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    await expect(section.getByText("Waiting for approval")).toBeVisible();
    await expect(section.getByText("proposed by an agent")).toBeVisible();
    await section.getByRole("button", { name: "Approve" }).click();
    await expect(section.getByText("Waiting for approval")).toHaveCount(0);
    expect((await read()).version).toBe(before.version + 1);
  } finally {
    const now = await read();
    await page.request.put(`/api/v1/projects/${alpha.id}/config`, {
      headers,
      data: { config: original, expectedVersion: now.version },
    });
  }
});
