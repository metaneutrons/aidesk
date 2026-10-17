import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, openPasswordSignIn, remote, test } from "./fixtures";
import { totp } from "./totp";
// Owner recovery: password plus TOTP. Other operators cannot use a password.
test.describe.configure({ mode: "serial" });
test("refuses a password for an operator who is not an owner", async ({ page, desk }) => {
  await page.goto("/login");
  await openPasswordSignIn(page);
  await page.getByLabel("Email address").fill(desk.plain);
  await page.getByLabel("Password").fill(desk.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Sign-in failed" })).toBeVisible();
  await expect(page.getByLabel("Authentication code")).toHaveCount(0);
  expect((await page.request.get("/api/v1/projects")).status()).toBe(401);
});
test("requires a valid authentication code after the owner password", async ({
  page,
  desk,
  baseURL,
}) => {
  await page.goto("/login");
  await openPasswordSignIn(page);
  await page.getByLabel("Email address").fill(desk.email);
  await page.getByLabel("Password").fill(desk.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const field = page.getByLabel("Authentication code");
  await expect(field).toBeVisible();
  expect((await page.request.get("/api/v1/projects")).status()).toBe(401);
  const wrong = String((Number(totp(desk.totpSecret)) + 500_000) % 1_000_000).padStart(6, "0");
  await field.fill(wrong);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The code is not valid" })).toBeVisible();
  await field.fill(totp(desk.totpSecret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(new URL("/", baseURL).href);
  expect((await page.request.get("/api/v1/projects")).status()).toBe(200);
});
test("accepts each backup code once", async ({ page, desk, baseURL }) => {
  const headers = { origin: baseURL ?? "" };
  const [first] = desk.backupCodes;
  for (const expected of [200, 401]) {
    await page.context().clearCookies();
    const signIn = await page.request.post("/api/auth/sign-in/email", {
      data: { email: desk.email, password: desk.password },
      headers,
    });
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
    const backup = await page.request.post("/api/auth/two-factor/verify-backup-code", {
      data: { code: first },
      headers,
    });
    expect(backup.status()).toBe(expected);
  }
});
test("never trusts a device and keeps TOTP in place", async ({ page, desk, baseURL }) => {
  const headers = { origin: baseURL ?? "" };
  await page.request.post("/api/auth/sign-in/email", {
    data: { email: desk.email, password: desk.password },
    headers,
  });
  const trusted = await page.request.post("/api/auth/two-factor/verify-totp", {
    data: { code: totp(desk.totpSecret), trustDevice: true },
    headers,
  });
  expect(trusted.status()).toBe(400);
  const verified = await page.request.post("/api/auth/two-factor/verify-totp", {
    data: { code: totp(desk.totpSecret) },
    headers,
  });
  expect(verified.ok()).toBe(true);
  for (const path of ["/api/auth/two-factor/disable", "/api/auth/two-factor/enable"]) {
    const response = await page.request.post(path, { data: { password: desk.password }, headers });
    expect(response.status()).toBe(403);
  }
});
test("closes the owner setup once an owner exists", async ({ page, baseURL }) => {
  await page.goto("/setup");
  await expect(page.getByRole("status")).toHaveText("An owner already exists. Sign in instead.");
  const response = await page.request.post("/api/setup/owner", {
    data: {
      token: "x".repeat(40),
      name: "Late",
      email: "late@example.test",
      password: "a long enough password",
    },
    headers: { origin: baseURL ?? "" },
  });
  expect(response.status()).toBe(403);
});
// The recovery token of the development stack is in its private environment file, or in the
// variable that a person gives for another instance.
function recoveryToken(): string | undefined {
  if (process.env.E2E_RECOVERY_TOKEN) return process.env.E2E_RECOVERY_TOKEN;
  try {
    return /^OWNER_RECOVERY_TOKEN=(.+)$/m.exec(readFileSync(".env.development", "utf8"))?.[1];
  } catch {
    return undefined;
  }
}
test("the recovery page repeats the password, refuses a wrong token and a wrong code, and is reached from the sign-in", async ({
  page,
  desk,
}) => {
  const token = recoveryToken();
  test.skip(!token || remote, "Needs the recovery token of the development stack.");
  await page.goto("/login");
  await openPasswordSignIn(page);
  await page.getByRole("link", { name: "Forgot the password?" }).click();
  await expect(page).toHaveURL(/\/recover$/);
  await expect(page.getByRole("heading", { name: "Set a new owner password" })).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // The password is asked for twice before anything is sent.
  await page.getByLabel("Recovery token").fill("not the token of this deployment");
  await page.getByLabel("Email address").fill(desk.email);
  await page.getByLabel("New password", { exact: true }).fill("a new password for the owner");
  await page.getByLabel("Repeat the password").fill("another password for the owner");
  await expect(page.getByRole("alert").filter({ hasText: "not the same" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByLabel("Repeat the password").fill("a new password for the owner");
  // A wrong token is refused at the first step.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "could not be started" })).toBeVisible();
  // The right token reaches the code, and a wrong code changes nothing.
  await page.getByLabel("Recovery token").fill(token ?? "");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Code or backup code").fill("000000");
  await page.getByRole("button", { name: "Set the password" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "code is not valid" })).toBeVisible();
  const scanCode = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scanCode.violations.map((violation) => violation.id)).toEqual([]);
  // The owner of the run still signs in with the old password.
  const headers = { origin: page.url().replace(/\/recover$/, "") };
  const signIn = await page.request.post("/api/auth/sign-in/email", {
    data: { email: desk.email, password: desk.password },
    headers,
  });
  expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
});
