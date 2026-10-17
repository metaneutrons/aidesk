import AxeBuilder from "@axe-core/playwright";
import { expect, openPasswordSignIn, remote, test } from "./fixtures";
// A passkey as the second factor of an owner, with the virtual authenticator of Chromium: it is added in the
// settings, offered first after the password, and the code stays as the way back.
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "The virtual authenticator is a feature of Chromium.",
);
test.skip(
  remote,
  "A run against a deployment limits the sign-ins; the passkey is covered on the development stack.",
);
test.describe.configure({ mode: "serial" });
test("an owner adds a passkey in the settings, signs in with it after the password, and can still use a code", async ({
  page,
  desk,
  signIn,
  context,
  baseURL,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: "Passkeys" });
  await expect(section).toBeVisible();
  await expect(section.getByText("No passkey yet.")).toBeVisible();
  await section.getByLabel("Name of the passkey").fill("E2E key");
  await section.getByRole("button", { name: "Add passkey" }).click();
  await expect(section.getByText("The passkey was added.")).toBeVisible();
  await expect(section.getByRole("listitem").filter({ hasText: "E2E key" })).toBeVisible();
  // The legacy mode scans in this page: the default opens a second page in the context, which was seen not to
  // come back while the context has a session of the virtual authenticator (the test ran into its timeout).
  const scan = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // Out, and in again: the password, then the passkey, and no code.
  const out = await page.request.post("/api/auth/sign-out", {
    data: {},
    headers: { origin: baseURL ?? "" },
  });
  expect(out.ok()).toBe(true);
  await page.goto("/login");
  await openPasswordSignIn(page);
  await page.getByLabel("Email address").fill(desk.email);
  await page.getByLabel("Password").fill(desk.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Confirm the sign-in with your passkey.")).toBeVisible();
  await expect(page.getByLabel("Authentication code")).toHaveCount(0);
  await page.getByRole("button", { name: "Use passkey" }).click();
  await expect(page).toHaveURL(new URL("/", baseURL).href);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The code is the way back: out again, the password, then "Use a code instead".
  await page.request.post("/api/auth/sign-out", { data: {}, headers: { origin: baseURL ?? "" } });
  await page.goto("/login");
  await openPasswordSignIn(page);
  await page.getByLabel("Email address").fill(desk.email);
  await page.getByLabel("Password").fill(desk.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Use a code instead" }).click();
  await expect(page.getByLabel("Authentication code")).toBeVisible();
  // Remove the passkey again, so that the owner of the run is as it was.
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Remove: E2E key" }).click();
  await expect(page.getByText("The passkey was removed.")).toBeVisible();
  await expect(page.getByText("No passkey yet.")).toBeVisible();
});
