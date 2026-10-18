import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// The branding of the customer page: set in the settings, seen by a customer who opens a link (name, line of text,
// logo, language, colour of the button), and taken away again. The logo is a small PNG that the test makes up.
test.describe.configure({ mode: "serial" });
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const brandingSchema = z.object({ displayName: z.string().nullable(), hasLogo: z.boolean() });
test("brands the customer page and takes the branding away again", async ({
  page,
  desk,
  signIn,
  browser,
  baseURL,
}) => {
  const { alpha } = desk.projects;
  const ticketId = alpha.tickets[0];
  const origin = { origin: baseURL ?? "" };
  const read = async () =>
    brandingSchema.parse(
      await (await page.request.get(`/api/v1/projects/${alpha.id}/portal-branding`)).json(),
    );
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page
    .locator("section.portal-branding")
    .filter({ has: page.getByRole("heading", { name: `Customer page of ${alpha.name}` }) });
  await expect(section).toBeVisible();
  await section.getByRole("heading", { name: `Customer page of ${alpha.name}` }).click();
  try {
    await section.getByLabel("Name", { exact: true }).fill("Example Support");
    await section.getByLabel("Line of text").fill("We answer within a day.");
    await section.getByPlaceholder("#5167ed").fill("#aa3355");
    await section.getByLabel("Language of the page").selectOption("de");
    await section.getByRole("button", { name: "Save", exact: true }).click({ timeout: 10_000 });
    await expect(section.getByText("The customer page was saved.")).toBeVisible();
    await section
      .getByLabel("Upload a logo (PNG, JPEG or WebP, up to 256 KiB)")
      .setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
    await expect(section.getByText("The logo was saved.")).toBeVisible();
    await expect(section.getByRole("img")).toBeVisible();
    // A file that is not an image is refused and the logo stays.
    await section
      .getByLabel("Upload a logo (PNG, JPEG or WebP, up to 256 KiB)")
      .setInputFiles({ name: "x.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
    await expect(
      section.getByText("The logo has to be a PNG, a JPEG or a WebP image."),
    ).toBeVisible();
    expect(await read()).toMatchObject({ displayName: "Example Support", hasLogo: true });
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
    // What the customer sees: the link of a ticket of the project, in English by the browser and German by the project.
    const issued = z.object({ url: z.string() }).parse(
      await (
        await page.request.post(`/api/v1/tickets/${ticketId}/portal-link`, {
          data: {},
          headers: origin,
        })
      ).json(),
    );
    const context = await browser.newContext({ locale: "en-US" });
    const customer = await context.newPage();
    try {
      await customer.goto(issued.url);
      const brand = customer.locator(".portal-brand");
      await expect(brand).toContainText("Example Support");
      await expect(brand).toContainText("We answer within a day.");
      await expect(brand.locator("img")).toHaveJSProperty("complete", true);
      expect(
        await brand.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth),
      ).toBe(1);
      // The project fixed German, the browser asked for English.
      await expect(customer.getByRole("button", { name: "Antwort senden" })).toBeVisible();
      const button = customer.locator(".portal .primary").first();
      await expect(button).toHaveCSS("background-color", "rgb(170, 51, 85)");
      await expect(button).toHaveCSS("color", "rgb(255, 255, 255)");
      const customerScan = await new AxeBuilder({ page: customer })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(customerScan.violations.map((violation) => violation.id)).toEqual([]);
      // The logo is not served without the link.
      const bare = await context.request.get("/api/portal/logo/not-a-token");
      expect(bare.status()).toBe(404);
    } finally {
      await context.close();
    }
  } finally {
    // The clean-up comes after seconds without a request, and WebKit sometimes sends it on a connection that the
    // server has closed in the meantime and then waits for an answer that never comes; a short wait and one more
    // try take care of it.
    const again = async (send: () => Promise<unknown>) => {
      await send().catch(send);
    };
    await again(() =>
      page.request.put(`/api/v1/projects/${alpha.id}/portal-branding`, {
        data: { displayName: null, headerText: null, accentColor: null, language: null },
        headers: origin,
        timeout: 8000,
      }),
    );
    await again(() =>
      page.request.post(`/api/v1/projects/${alpha.id}/portal-branding/logo/delete`, {
        data: {},
        headers: origin,
        timeout: 8000,
      }),
    );
  }
  expect(await read()).toMatchObject({ displayName: null, hasLogo: false });
});
