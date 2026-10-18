import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
import { certificates } from "../support/certificates";
// The identity providers in the settings: a SAML provider is registered with its certificate, waits for the record
// of its domain, is looked for and tested, switched off and on, and deleted by typing its identifier. The proof of
// a domain needs a DNS that the test does not have, so it stops at the record.
test.describe.configure({ mode: "serial" });
test("registers a provider, switches it off and on, tests it and deletes it", async ({
  page,
  desk,
  signIn,
}) => {
  const id = `ui-${desk.run}`.toLowerCase();
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page
    .locator("section.sso-providers")
    .filter({ has: page.getByRole("heading", { name: "Identity providers" }) });
  await expect(section).toBeVisible();
  try {
    await section.getByText("Register a provider").click();
    await section.getByLabel("SAML", { exact: true }).check();
    await section.getByLabel("Identifier (lower case, for example keycloak)").fill(id);
    await section.getByLabel("Issuer address").fill("https://idp.example.test/saml");
    await section.getByLabel("Domain of the e-mail addresses").first().fill(`${id}.example.test`);
    await section
      .getByLabel("Sign-in address of the provider")
      .fill("https://idp.example.test/saml/sso");
    await section.getByLabel("Signing certificate (PEM)").fill(certificates.long);
    await section.getByRole("button", { name: "Register the provider" }).click();
    await expect(section.getByText(`${id} was registered.`)).toBeVisible();
    const entry = section.getByRole("listitem").filter({ hasText: id }).first();
    await expect(entry.getByText("Waiting for the domain record", { exact: true })).toBeVisible();
    // The record that proves the domain is shown, and a look at the DNS does not find it.
    await entry.getByRole("button", { name: `Show the record of ${id}` }).click();
    await expect(
      entry
        .locator("code")
        .filter({ hasText: `_better-auth-token-${id}` })
        .first(),
    ).toBeVisible();
    await entry.getByRole("button", { name: `Verify the domain of ${id}` }).click();
    await expect(section.getByText(/was not found yet/)).toBeVisible();
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
    // The test reads what it can without signing anybody in; the domain is not verified, which it says.
    await entry.getByRole("button", { name: `Test ${id}` }).click();
    await expect(section.getByText(`${id} was tested`)).toBeVisible();
    await expect(entry.getByText(/Problem: domain/)).toBeVisible();
    // Switched off and on again.
    await entry.getByRole("button", { name: `Switch ${id} off` }).click();
    await expect(entry.getByText("Switched off", { exact: true })).toBeVisible();
    await entry.getByRole("button", { name: `Switch ${id} on` }).click();
    await expect(entry.getByText("Waiting for the domain record", { exact: true })).toBeVisible();
    // Deleted only when the identifier is typed.
    const remove = entry.getByRole("button", { name: `Delete ${id}` });
    await entry.getByLabel(`To delete ${id}, type its identifier`).fill(`${id}x`);
    await expect(remove).toBeDisabled();
    await entry.getByLabel(`To delete ${id}, type its identifier`).fill(id);
    await remove.click();
    await expect(section.getByText(`${id} was deleted.`)).toBeVisible();
  } finally {
    // Whatever happened above, the provider is not left behind.
    const left = z
      .array(z.object({ providerId: z.string() }))
      .parse(await (await page.request.get("/api/v1/sso-providers")).json());
    if (left.some((row) => row.providerId === id))
      await page.request.post(`/api/v1/sso-providers/${id}/delete`, {
        headers: { origin: new URL(page.url()).origin },
        data: { confirm: id },
      });
  }
});
