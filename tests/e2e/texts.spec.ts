import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Texts: a project's own wording replaces the built-in text, here on the
// customer page, and returns to it when the text is reset.
test.describe.configure({ mode: "serial" });
// This test failed twice in CI with `socket hang up (ECONNRESET)` on its first API
// request after a long step in the page. The likely cause is a connection that the
// server had closed while it was idle (the default of Node is 5 seconds) and that
// the client used again. Playwright repeats exactly that error, so the calls ask for it.
test("sets the label of the reply button and resets it", async ({
  page,
  desk,
  signIn,
  browser,
  baseURL,
}) => {
  const { alpha } = desk.projects;
  const label = `Submit answer ${desk.run}`;
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: `Texts of ${alpha.name}` });
  const entry = section.getByRole("group", { name: "Label of the button that sends a reply" });
  const field = entry.getByRole("textbox", { name: /\(English\)/ });
  await expect(field).toHaveValue("Send reply");
  try {
    await field.fill(label);
    await entry.getByRole("button", { name: "Save English text" }).click();
    await expect(section.getByText("Saved.")).toBeVisible();
    await expect(field).toHaveValue(label);
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
    // The customer page shows the project's wording.
    const link = z.object({ url: z.string() }).parse(
      await (
        await page.request.post(`/api/v1/tickets/${alpha.tickets[0]}/portal-link`, {
          headers: { origin: baseURL ?? "" },
          data: {},
          maxRetries: 3,
        })
      ).json(),
    );
    const customer = await (await browser.newContext({ locale: "en" })).newPage();
    await customer.goto(link.url);
    await expect(customer.getByRole("button", { name: label })).toBeVisible();
    // Reset: the built-in wording returns.
    await entry.getByRole("button", { name: "Use the built-in wording (English)" }).click();
    await expect(field).toHaveValue("Send reply");
    await customer.reload();
    await expect(customer.getByRole("button", { name: "Send reply" })).toBeVisible();
  } finally {
    const versions = z.array(z.object({ version: z.number(), text: z.string().nullable() })).parse(
      await (
        await page.request.get(`/api/v1/projects/${alpha.id}/texts/portal.send/en/versions`, {
          maxRetries: 3,
        })
      ).json(),
    );
    if (versions[0]?.text !== null && versions[0] !== undefined)
      await page.request.put(`/api/v1/projects/${alpha.id}/texts/portal.send/en`, {
        headers: { origin: baseURL ?? "" },
        data: { text: null, expectedVersion: versions[0].version },
        maxRetries: 3,
      });
  }
});
