import { expect, openPasswordSignIn, test } from "./fixtures";
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
