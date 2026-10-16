import AxeBuilder from "@axe-core/playwright";
import { expect, remote, test } from "./fixtures";
// Connections: defined through the API, tested and disabled on the settings
// page, which never shows a credential.
test.describe.configure({ mode: "serial" });
test("tests a connection, shows why a failing one fails and disables one", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  test.skip(remote, "The connections of this test are mail servers of the development stack.");
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  await signIn();
  const base = `/api/v1/projects/${alpha.id}/connections`;
  const define = (name: string, port: number) =>
    page.request.post(base, {
      headers,
      data: {
        kind: "smtp",
        direction: "outbound",
        name,
        config: {
          host: "mailpit",
          port,
          secure: false,
          from: "e2e@support.local",
          replyTo: "e2e@support.local",
          developmentOnly: true,
        },
        secret: { user: "never-shown-user", pass: "never-shown-pass" },
      },
    });
  const good = `Good ${desk.run}`;
  const bad = `Bad ${desk.run}`;
  expect((await define(good, 1025)).status()).toBe(201);
  expect((await define(bad, 1)).status()).toBe(201);
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: `Connections of ${alpha.name}` });
  const row = (name: string) => section.getByRole("listitem").filter({ hasText: name });
  await expect(row(good).getByText("Not tested")).toBeVisible();
  await section.getByRole("button", { name: `Test ${good}` }).click();
  await expect(row(good).getByText("Ready")).toBeVisible();
  await section.getByRole("button", { name: `Test ${bad}` }).click();
  await expect(row(bad).getByText("Failing (connect_failed)")).toBeVisible();
  // No credential reaches the page or the API.
  await expect(page.getByText("never-shown-pass")).toHaveCount(0);
  const listed = await (await page.request.get(base)).text();
  expect(listed).not.toContain("never-shown");
  expect(listed).toContain('"secretSet":true');
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // The configuration offers the new outgoing connection (not saved here, so
  // the project keeps sending through its own).
  const config = page.getByRole("region", { name: `Configuration of ${alpha.name}` });
  await expect(
    config.getByLabel("Outgoing connection").locator("option", { hasText: good }),
  ).toHaveCount(1);
  await section.getByRole("button", { name: `Disable ${bad}` }).click();
  await expect(row(bad).getByText("Disabled")).toBeVisible();
  await expect(section.getByRole("button", { name: `Test ${bad}` })).toBeDisabled();
  await expect(
    config.getByLabel("Outgoing connection").locator("option", { hasText: bad }),
  ).toHaveCount(0);
  await section.getByRole("button", { name: `Disable ${good}` }).click();
  await expect(row(good).getByText("Disabled")).toBeVisible();
});
test("defines and changes connections in a form, and never shows the credentials again", async ({
  page,
  desk,
  signIn,
}) => {
  // Gamma: the connections made here are sources of knowledge, which other specs expect alpha not to have.
  const { gamma } = desk.projects;
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: `Connections of ${gamma.name}` });
  const docs = `Guide ${desk.run}`;
  await section.getByRole("button", { name: "Add connection" }).click();
  const form = section.locator("form.connection-form");
  await form.getByLabel("Type").selectOption({ label: "Documentation · source of knowledge" });
  await form.getByLabel("Name", { exact: true }).fill(docs);
  await form.getByLabel("Pages").fill("Guide | https://example.com/guide");
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  await form.getByRole("button", { name: "Create connection" }).click();
  await expect(section.locator("li strong").filter({ hasText: docs })).toBeVisible();
  // A definition that the API refuses says which field it is.
  await section.getByRole("button", { name: "Add connection" }).click();
  await form.getByLabel("Type").selectOption({ label: "GitHub · source of knowledge" });
  await form.getByLabel("Name", { exact: true }).fill(`Repositories ${desk.run}`);
  await form.getByLabel("Repositories").fill("not a repository");
  await form.getByLabel("Token").fill("ghp-form-secret");
  await form.getByRole("button", { name: "Create connection" }).click();
  await expect(form.getByRole("alert")).toContainText("repositories");
  await form.getByLabel("Repositories").fill("acme/app");
  await form.getByRole("button", { name: "Create connection" }).click();
  await expect(
    section.locator("li strong").filter({ hasText: `Repositories ${desk.run}` }),
  ).toBeVisible();
  // Changing one keeps the credentials that are left empty, and the form does not show them.
  await section.getByRole("button", { name: `Edit Repositories ${desk.run}` }).click();
  await expect(form.getByLabel("Token")).toHaveValue("");
  await expect(form.getByLabel("Token")).toHaveAttribute("placeholder", /Leave empty/);
  await form.getByLabel("Name", { exact: true }).fill(`Repos ${desk.run}`);
  await form.getByLabel("Repositories").fill("acme/app\nacme/docs");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(section.locator("li strong").filter({ hasText: `Repos ${desk.run}` })).toBeVisible();
  const list = await page.request.get(`/api/v1/projects/${gamma.id}/connections`);
  const text = await list.text();
  expect(text).not.toContain("ghp-form-secret");
  const rows = JSON.parse(text) as {
    name: string;
    secretSet: boolean;
    config: { repositories?: string[] };
  }[];
  const changed = rows.find((row) => row.name === `Repos ${desk.run}`);
  expect(changed).toMatchObject({
    secretSet: true,
    config: { repositories: ["acme/app", "acme/docs"] },
  });
  expect(rows.find((row) => row.name === docs)?.secretSet).toBe(false);
});
