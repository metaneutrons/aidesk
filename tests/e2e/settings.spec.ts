import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "./fixtures";
import { createIdpUser, deleteIdpUser } from "./keycloak";
// Operator and token administration through the settings view.
test.describe.configure({ mode: "serial" });
async function openSettings(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Operators" })).toBeVisible();
}
test("an operator added in settings signs in through SSO with the granted access", async ({
  page,
  desk,
  signIn,
  browser,
}) => {
  const email = `${desk.prefix}-invited@oidc.aidesk.test`;
  const password = randomBytes(16).toString("hex");
  await signIn();
  await openSettings(page);
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("heading", { name: "Add operator" }) });
  await form.getByLabel("Name").fill(`Invited ${desk.run}`);
  await form.getByLabel("Email address").fill(email);
  await form.getByRole("button", { name: "Add operator" }).click();
  const role = page.getByLabel(`Role: Invited ${desk.run}, ${desk.projects.alpha.name}`);
  await expect(role).toHaveValue("none");
  await expect(
    page.getByLabel(`Role: Invited ${desk.run}, ${desk.projects.beta.name}`),
  ).toHaveCount(0);
  await role.selectOption("read");
  await expect(role).toHaveValue("read");
  await createIdpUser(email, password);
  try {
    const context = await browser.newContext();
    const operator = await context.newPage();
    await operator.goto("/login");
    await operator.getByLabel("Email address").fill(email);
    await operator.getByRole("button", { name: "Continue with SSO" }).click();
    await operator.waitForURL(/^http:\/\/localhost:8080\//);
    await operator.locator("#username").fill(email);
    await operator.locator("#password").fill(password);
    await operator.locator("#kc-login").click();
    await expect(operator).toHaveURL("http://localhost:3000/");
    const projects = z
      .array(z.object({ id: z.string() }))
      .parse(await (await operator.request.get("/api/v1/projects")).json());
    expect(projects.map((project) => project.id)).toEqual([desk.projects.alpha.id]);
    await context.close();
  } finally {
    await deleteIdpUser(email);
  }
});
test("disables an operator and shows the state", async ({ page, desk, signIn }) => {
  await signIn();
  await openSettings(page);
  const row = page.getByRole("row").filter({ hasText: `Invited ${desk.run}` });
  await row.getByRole("button", { name: `Disable: Invited ${desk.run}` }).click();
  await expect(row.getByText("Disabled")).toBeVisible();
  await row.getByRole("button", { name: `Enable: Invited ${desk.run}` }).click();
  await expect(row.getByText("Active")).toBeVisible();
});
test("issues a token once and revokes it", async ({ page, desk, signIn }) => {
  await signIn();
  await openSettings(page);
  await page.getByLabel("Project", { exact: true }).selectOption(desk.projects.alpha.id);
  await page.getByLabel("Token name").fill("Settings token");
  await page.getByLabel("Access").selectOption("notes");
  await page.getByRole("button", { name: "Issue token" }).click();
  const shown = page.getByRole("status").filter({ hasText: "It is not shown again" });
  await expect(shown).toBeVisible();
  const token = (await shown.locator("code").textContent()) ?? "";
  expect(token).toMatch(/^aidesk_/);
  const bearer = { authorization: `Bearer ${token}` };
  expect((await page.request.get("/api/v1/projects", { headers: bearer })).status()).toBe(200);
  const item = page.getByRole("listitem").filter({ hasText: "Settings token" });
  await expect(item.getByText("Read and notes")).toBeVisible();
  await item.getByRole("button", { name: "Revoke: Settings token" }).click();
  await expect(item.getByText("Revoked")).toBeVisible();
  expect((await page.request.get("/api/v1/projects", { headers: bearer })).status()).toBe(401);
});
