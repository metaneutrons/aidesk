import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, openSettings, remote, test } from "./fixtures";
import { createIdpUser, deleteIdpUser } from "./keycloak";
// A project is made in the settings, by the owner: the topic "Projects" has a button for it, the header has none in any
// view, a person who is not the owner is never offered it, and a desk without a project says what to do first.
test.describe.configure({ mode: "serial" });
const scan = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
const section = (page: Page) => page.locator("section.new-project");
test("has no button for a new project in the header of any view", async ({ page, signIn }) => {
  await signIn();
  await page.goto("/");
  const menu = page.getByRole("navigation");
  for (const view of ["Overview", "Inbox", "Overdue", "Notifications", "Junk", "Settings"]) {
    await menu.getByRole("button", { name: new RegExp(`^${view}`) }).click();
    await expect(page.getByRole("heading", { level: 1, name: view, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New project" })).toHaveCount(0);
  }
});
test("creates a project in the settings, says what went wrong and finds it in the lists", async ({
  page,
  desk,
  signIn,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Every run adds a project to the installation; one browser does.",
  );
  await signIn();
  await page.goto("/");
  await openSettings(page, "Projects");
  await expect(section(page).getByRole("heading", { name: "Create a project" })).toBeVisible();
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  const name = `E2E Settings Project ${desk.run}`;
  const slug = `${desk.prefix}-settings`;
  await section(page).getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByLabel("Project address").fill(slug);
  expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.locator("section.project-lifecycle li").filter({ hasText: name }),
  ).toBeVisible();
  // The same address twice is refused, the dialog stays open with its own message, and nothing else on the page is told.
  await section(page).getByRole("button", { name: "New project" }).click();
  await dialog.getByLabel("Project name").fill(`${name} again`);
  await dialog.getByLabel("Project address").fill(slug);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog).toBeVisible();
  // A closed dialog does not keep the message for the next time.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await section(page).getByRole("button", { name: "New project" }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // It is a project of the lists too.
  await page.getByRole("navigation").getByRole("button", { name: "Inbox" }).click();
  await page.getByRole("button", { name: "All projects" }).click();
  await expect(page.getByRole("checkbox", { name })).toBeVisible();
});
test.describe("on a narrow screen", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("is offered at the top of the topic Projects", async ({ page, signIn }) => {
    await signIn();
    await page.goto("/");
    await openSettings(page, "Projects");
    const trigger = section(page).getByRole("button", { name: "New project" });
    await expect(trigger).toBeVisible();
    const box = await trigger.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "New project" })).toBeVisible();
    expect((await scan(page)).violations.map((violation) => violation.id)).toEqual([]);
  });
});
test.describe("in German", () => {
  test.use({ locale: "de-DE" });
  test("names the section and the button in German", async ({ page, signIn }) => {
    await signIn();
    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "Einstellungen" }).click();
    await page
      .getByRole("complementary")
      .getByRole("link", { name: "Projekte", exact: true })
      .click();
    await expect(section(page).getByRole("heading", { name: "Projekt anlegen" })).toBeVisible();
    await expect(section(page).getByRole("button", { name: "Neues Projekt" })).toBeVisible();
  });
});
test("tells a person without any project that the owner creates them, and offers nothing", async ({
  page,
  desk,
  signIn,
  browser,
  browserName,
}) => {
  test.skip(remote, "Signing in through SSO needs the identity provider of the development stack.");
  test.skip(browserName !== "chromium", "The operator of this test is made once.");
  const email = `${desk.prefix}-noproject@oidc.aidesk.test`;
  const password = randomBytes(16).toString("hex");
  await signIn();
  await page.goto("/");
  await openSettings(page, "People");
  const form = page
    .locator("form")
    .filter({ has: page.getByRole("heading", { name: "Add operator" }) });
  await form.getByLabel("Name").fill(`No project ${desk.run}`);
  await form.getByLabel("Email address").fill(email);
  await form.getByRole("button", { name: "Add operator" }).click();
  await expect(
    page.getByLabel(`Role: No project ${desk.run}, ${desk.projects.alpha.name}`),
  ).toHaveValue("none");
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
    await expect(operator.getByRole("heading", { name: "There is no project yet" })).toBeVisible();
    await expect(
      operator.getByText("The owner of this installation creates projects."),
    ).toBeVisible();
    await expect(operator.getByRole("link", { name: "Create the first project" })).toHaveCount(0);
    await expect(operator.getByRole("button", { name: "New project" })).toHaveCount(0);
    expect((await scan(operator)).violations.map((violation) => violation.id)).toEqual([]);
    await operator.goto("/?settings=projects");
    await expect(operator.getByRole("button", { name: "New project" })).toHaveCount(0);
    await context.close();
  } finally {
    await deleteIdpUser(email);
  }
});
