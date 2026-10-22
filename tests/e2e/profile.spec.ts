import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, fixture, test } from "./fixtures";
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
// Times in the desk follow the zone of the profile. The list of notifications shows the time of each entry, so it
// serves to see the zone: the same instant reads differently in two zones that are a day apart.
test("shows times in the time zone of the profile and refuses one that does not exist", async ({
  page,
  desk,
  signIn,
}) => {
  await signIn();
  fixture("notify", desk.projects.alpha.tickets[0]);
  const created = z
    .object({ notifications: z.array(z.object({ createdAt: z.string() })) })
    .parse(await (await page.request.get("/api/v1/me/notifications?limit=1")).json())
    .notifications[0]?.createdAt;
  // Each engine writes a date in its own way ("Oct 22, 2026, 4:15 AM" or "... at ..."), so the browser itself says how.
  const at = (zone: string) =>
    page.evaluate(
      ([iso, timeZone]) =>
        new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone }).format(
          new Date(iso ?? ""),
        ),
      [created, zone],
    );
  expect(await at("Pacific/Kiritimati")).not.toBe(await at("Pacific/Pago_Pago"));
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page
    .locator("section.profile")
    .filter({ has: page.getByRole("heading", { name: "Your profile" }) });
  const zone = section.getByLabel("Time zone");
  const save = section.getByRole("button", { name: "Save profile" });
  const listed = async () => {
    await page
      .getByRole("navigation")
      .getByRole("button", { name: /^Notifications/ })
      .click();
    // Not the first entry: the worker can add a newer one (an overdue ticket) while the test runs.
    return page.locator("section.notifications");
  };
  try {
    for (const name of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
      await zone.fill(name);
      await save.click();
      await expect(section.getByText("The profile was saved.")).toBeVisible();
      await expect(await listed()).toContainText(await at(name));
    }
    // A name that is no zone is refused by the server, and the stored zone stays.
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    await zone.fill("Mars/Olympus");
    await save.click();
    await expect(section.getByText("The profile could not be saved.")).toBeVisible();
    expect(
      z
        .object({ timeZone: z.string().nullable() })
        .parse(await (await page.request.get("/api/v1/me/profile")).json()).timeZone,
    ).toBe("Pacific/Pago_Pago");
  } finally {
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    await zone.fill("");
    if (await save.isEnabled()) await save.click();
  }
  await expect(section.getByText("The profile was saved.")).toBeVisible();
  expect(
    z
      .object({ timeZone: z.string().nullable() })
      .parse(await (await page.request.get("/api/v1/me/profile")).json()).timeZone,
  ).toBeNull();
});
