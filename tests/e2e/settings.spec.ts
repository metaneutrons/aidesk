import { randomBytes } from "node:crypto";
import { z } from "zod";
import { expect, openSettings, remote, test } from "./fixtures";
import { createIdpUser, deleteIdpUser } from "./keycloak";
// Operator and token administration through the settings view.
test.describe.configure({ mode: "serial" });
test("an operator added in settings signs in through SSO with the granted access", async ({
  page,
  desk,
  signIn,
  browser,
}) => {
  test.skip(remote, "Signing in through SSO needs the identity provider of the development stack.");
  const email = `${desk.prefix}-invited@oidc.aidesk.test`;
  const password = randomBytes(16).toString("hex");
  await signIn();
  await page.goto("/");
  await openSettings(page, "People");
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
    // A person who manages nothing has no settings of the workspace, but their account: it is behind their name, and an
    // address of the settings of the workspace shows it as well.
    const menu = operator.getByRole("navigation");
    await expect(menu.getByRole("button", { name: "Inbox" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
    await operator.getByRole("button", { name: `Account of Invited ${desk.run}` }).click();
    await expect(operator.getByRole("heading", { level: 2, name: "Profile" })).toBeVisible();
    await operator.goto("/?settings=people");
    await expect(operator.getByRole("heading", { level: 2, name: "Profile" })).toBeVisible();
    await expect(operator).toHaveURL(/\/\?settings=account$/);
    await context.close();
  } finally {
    await deleteIdpUser(email);
  }
});
test("disables an operator and shows the state", async ({ page, desk, signIn }) => {
  test.skip(
    remote,
    "The operator of this test is made by the SSO test, which a deployment does not run.",
  );
  await signIn();
  await page.goto("/");
  await openSettings(page, "People");
  const row = page.getByRole("row").filter({ hasText: `Invited ${desk.run}` });
  await row.getByRole("button", { name: `Disable: Invited ${desk.run}` }).click();
  await expect(row.getByText("Disabled")).toBeVisible();
  await row.getByRole("button", { name: `Enable: Invited ${desk.run}` }).click();
  await expect(row.getByText("Active")).toBeVisible();
});
test("issues a token that may read files only when that access is chosen", async ({
  page,
  desk,
  signIn,
}) => {
  await signIn();
  await page.goto("/");
  await openSettings(page, "Agents and tokens", desk.projects.alpha.name);
  await page.getByLabel("Token name").fill("Files token");
  await page.getByLabel("Access").selectOption("readFiles");
  await page.getByRole("button", { name: "Issue token" }).click();
  await expect(page.getByRole("status").filter({ hasText: "It is not shown again" })).toBeVisible();
  const item = page.getByRole("listitem").filter({ hasText: "Files token" });
  await expect(item.getByText("Read, with attachments and mail sources")).toBeVisible();
  const listed = z
    .array(z.object({ name: z.string(), actions: z.array(z.string()) }))
    .parse(
      await (await page.request.get(`/api/v1/projects/${desk.projects.alpha.id}/agents`)).json(),
    );
  expect(listed.find((entry) => entry.name === "Files token")?.actions.sort()).toEqual([
    "project.read",
    "ticket.read",
    "ticket.read_files",
  ]);
  // The other accesses never include it.
  const options = await page.getByLabel("Access").locator("option").allTextContents();
  expect(options).toEqual([
    "Read",
    "Read, with attachments and mail sources",
    "Read and notes",
    "Respond",
  ]);
  await item.getByRole("button", { name: "Revoke: Files token" }).click();
  await expect(item.getByText("Revoked")).toBeVisible();
});
test("issues a token once and revokes it", async ({ page, desk, signIn }) => {
  await signIn();
  await page.goto("/");
  await openSettings(page, "Agents and tokens", desk.projects.alpha.name);
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
test("creates a managed agent without a token and revokes it", async ({ page, desk, signIn }) => {
  await signIn();
  await page.goto("/");
  await openSettings(page, "Agents and tokens", desk.projects.alpha.name);
  await page.getByLabel("Token name").fill("Settings managed agent");
  await page.getByLabel("Access").selectOption("respond");
  await page.getByLabel("Run by aidesk (managed agent, no token)").check();
  // A managed agent has no end date.
  await expect(page.getByLabel("Valid for")).toHaveCount(0);
  await page.getByRole("button", { name: "Create managed agent" }).click();
  await expect(page.getByText("The managed agent was created.")).toBeVisible();
  await expect(page.getByText("It is not shown again")).toHaveCount(0);
  const item = page.getByRole("listitem").filter({ hasText: "Settings managed agent" });
  await expect(item.getByText("Managed agent", { exact: true })).toBeVisible();
  // The API lists it as managed, with the access that was chosen.
  const list = z
    .array(z.object({ name: z.string(), managed: z.boolean(), actions: z.array(z.string()) }))
    .parse(
      await (await page.request.get(`/api/v1/projects/${desk.projects.alpha.id}/agents`)).json(),
    );
  const created = list.find((agent) => agent.name === "Settings managed agent");
  expect(created?.managed).toBe(true);
  expect(created?.actions).toContain("ticket.reply");
  await item.getByRole("button", { name: "Revoke: Settings managed agent" }).click();
  await expect(item.getByText("Revoked")).toBeVisible();
});
