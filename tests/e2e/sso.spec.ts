import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, fixture, test } from "./fixtures";
// Real OIDC and SAML sign-in against the development Keycloak realm. Each
// worker uses its own IdP accounts and aidesk operators (see fixtures.ts).
const projects = z.array(z.object({ id: z.string() }));
async function ssoSignIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Continue with SSO" }).click();
  await page.waitForURL(/^http:\/\/localhost:8080\/realms\/aidesk\//);
  await page.locator("#username").fill(email);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
}
function sessionCookieSet(headers: Record<string, string>): boolean {
  return /session_token=[^;]+/.test(headers["set-cookie"] ?? "");
}
test.describe.configure({ mode: "serial" });
test("signs in a provisioned operator through OIDC", async ({ page, desk }) => {
  const callback = page.waitForRequest((request) =>
    request.url().includes("/api/auth/sso/callback/keycloak-oidc"),
  );
  await ssoSignIn(page, desk.sso.oidc, desk.idpPassword);
  await expect(page).toHaveURL("http://localhost:3000/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Overview");
  const visible = projects.parse(await (await page.request.get("/api/v1/projects")).json());
  expect(visible.map((project) => project.id)).toEqual([desk.projects.alpha.id]);
  // Replaying the authorization response must not create another session,
  // neither in the same browser (state already consumed) nor elsewhere.
  const url = (await callback).url();
  const again = await page.request.get(url, { maxRedirects: 0 });
  expect(again.status()).toBe(302);
  expect(again.headers().location).toMatch(/error=/);
  expect(sessionCookieSet(again.headers())).toBe(false);
  const stranger = await page.context().browser()?.newContext();
  const elsewhere = await stranger?.request.get(url, { maxRedirects: 0 });
  expect(elsewhere?.status()).toBe(302);
  expect(elsewhere?.headers().location).toMatch(/error=/);
  expect(sessionCookieSet(elsewhere?.headers() ?? {})).toBe(false);
  await stranger?.close();
});
test("signs in a provisioned operator through SAML and rejects a replayed response", async ({
  page,
  desk,
  baseURL,
}) => {
  const acs = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().includes("/sso/saml2/sp/acs/keycloak-saml"),
  );
  await ssoSignIn(page, desk.sso.saml, desk.idpPassword);
  await expect(page).toHaveURL("http://localhost:3000/");
  const visible = projects.parse(await (await page.request.get("/api/v1/projects")).json());
  expect(visible.map((project) => project.id)).toEqual([desk.projects.alpha.id]);
  const response = await acs;
  const replayContext = await page
    .context()
    .browser()
    ?.newContext(baseURL ? { baseURL } : {});
  const replay = await replayContext?.request.post(response.url(), {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    data: response.postData() ?? "",
    maxRedirects: 0,
  });
  expect(replay?.status()).toBeGreaterThanOrEqual(300);
  expect(sessionCookieSet(replay?.headers() ?? {})).toBe(false);
  const after = await replayContext?.request.get("/api/v1/projects");
  expect(after?.status()).toBe(401);
  await replayContext?.close();
});
test("rejects an IdP user without an aidesk account and does not create one", async ({
  page,
  desk,
}) => {
  await ssoSignIn(page, desk.sso.stranger, desk.idpPassword);
  await expect(page).toHaveURL(/\/login\?sso=failed/);
  await expect(page.getByRole("alert").filter({ hasText: "SSO sign-in failed" })).toBeVisible();
  expect((await page.request.get("/api/v1/projects")).status()).toBe(401);
  expect(JSON.parse(fixture("user-count", desk.sso.stranger))).toEqual({ count: 0 });
});
test("refuses SSO requests that ask for sign-up", async ({ page, desk, baseURL }) => {
  const response = await page.request.post("/api/auth/sign-in/sso", {
    data: { email: desk.sso.stranger, callbackURL: "/", requestSignUp: true },
    headers: { origin: baseURL ?? "" },
  });
  expect(response.status()).toBe(400);
  // The auth endpoints also parse form bodies; the flag must not pass that way.
  const form = await page.request.post("/api/auth/sign-in/sso", {
    form: { email: desk.sso.stranger, callbackURL: "/", requestSignUp: "true" },
    headers: { origin: baseURL ?? "" },
  });
  expect(form.status()).toBe(400);
  expect(JSON.parse(fixture("user-count", desk.sso.stranger))).toEqual({ count: 0 });
});
test("ends access when sessions are revoked", async ({ page, desk }) => {
  await ssoSignIn(page, desk.sso.saml, desk.idpPassword);
  await expect(page).toHaveURL("http://localhost:3000/");
  expect((await page.request.get("/api/v1/projects")).status()).toBe(200);
  fixture("revoke-sessions", desk.sso.saml);
  expect((await page.request.get("/api/v1/projects")).status()).toBe(401);
});
test("ends access when the operator is disabled", async ({ page, desk }) => {
  await ssoSignIn(page, desk.sso.oidc, desk.idpPassword);
  await expect(page).toHaveURL("http://localhost:3000/");
  expect((await page.request.get("/api/v1/projects")).status()).toBe(200);
  fixture("disable", desk.sso.oidc);
  expect((await page.request.get("/api/v1/projects")).status()).toBe(401);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});
