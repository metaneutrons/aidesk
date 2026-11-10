import { connect } from "node:net";
import AxeBuilder from "@axe-core/playwright";
import { expect, openSettings, remote, test } from "./fixtures";
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
  await openSettings(page, "Connections", alpha.name);
  const section = page.getByRole("region", { name: `Connections` });
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
  await openSettings(page, "General", alpha.name);
  const config = page.getByRole("region", { name: `Configuration` });
  await expect(
    config.getByLabel("Outgoing connection").locator("option", { hasText: good }),
  ).toHaveCount(1);
  await openSettings(page, "Connections", alpha.name);
  await section.getByRole("button", { name: `Disable ${bad}` }).click();
  await expect(row(bad).getByText("Disabled")).toBeVisible();
  await expect(section.getByRole("button", { name: `Test ${bad}` })).toBeDisabled();
  await openSettings(page, "General", alpha.name);
  await expect(
    config.getByLabel("Outgoing connection").locator("option", { hasText: bad }),
  ).toHaveCount(0);
  await openSettings(page, "Connections", alpha.name);
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
  await openSettings(page, "Connections", gamma.name);
  const section = page.getByRole("region", { name: `Connections` });
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
test("makes a token for the HTTPS endpoint, shows it once and answers the sender with the documented statuses", async ({
  page,
  desk,
  signIn,
}) => {
  // Gamma, like the form test above. No message is taken here, so no ticket is made in the project.
  const { gamma } = desk.projects;
  await signIn();
  await page.goto("/");
  await openSettings(page, "Connections", gamma.name);
  const section = page.getByRole("region", { name: `Connections` });
  const name = `Endpoint ${desk.run}`;
  const address = `endpoint-${desk.run}@example.test`;
  await section.getByRole("button", { name: "Add connection" }).click();
  const form = section.locator("form.connection-form");
  await form.getByLabel("Type").selectOption({ label: "HTTPS endpoint · incoming" });
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Receiving addresses").fill(address);
  await form.getByRole("button", { name: "Generate a token" }).click();
  await expect(form.getByText("Copy the token now")).toBeVisible();
  const token = await form.getByLabel("Token").inputValue();
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  await form.getByRole("button", { name: "Create connection" }).click();
  await expect(section.locator("li strong").filter({ hasText: name })).toBeVisible();
  const row = section.getByRole("listitem").filter({ hasText: name });
  await section.getByRole("button", { name: `Test ${name}` }).click();
  await expect(row.getByText("Ready")).toBeVisible();
  // The token is not shown again, neither on the page nor by the API.
  await expect(page.getByText(token)).toHaveCount(0);
  const listed = await page.request.get(`/api/v1/projects/${gamma.id}/connections`);
  const text = await listed.text();
  expect(text).not.toContain(token);
  const connection = (JSON.parse(text) as { id: string; name: string }[]).find(
    (entry) => entry.name === name,
  );
  const url = `/api/inbound/${connection?.id ?? ""}`;
  const send = (headers: Record<string, string>) =>
    page.request.post(url, {
      headers: { "content-type": "message/rfc822", ...headers },
      data: "From: a@example.test\r\nSubject: x\r\n\r\nx\r\n",
    });
  const good = {
    authorization: `Bearer ${token}`,
    "x-aidesk-recipient": address,
    "x-aidesk-delivery-id": `e2e-${desk.run}-delivery`,
  };
  expect((await send({ ...good, authorization: "Bearer wrong" })).status()).toBe(401);
  expect((await send({ ...good, "x-aidesk-recipient": "other@example.test" })).status()).toBe(422);
  expect((await send({ ...good, "x-aidesk-delivery-id": "" })).status()).toBe(400);
  expect((await send({ authorization: good.authorization })).status()).toBe(400);
  // A disabled connection takes nothing, and answers like one that does not exist.
  await section.getByRole("button", { name: `Disable ${name}` }).click();
  await expect(row.getByText("Disabled")).toBeVisible();
  expect((await send(good)).status()).toBe(401);
});
// The code of the answer to RCPT TO, from the receiver of the development stack. No message follows, so nothing is made.
function recipientCode(address: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(2525, "127.0.0.1");
    const steps = ["EHLO e2e.example", "MAIL FROM:<sender@e2e.example>", `RCPT TO:<${address}>`];
    let buffer = "";
    let step = -1;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const last = buffer.trimEnd().split("\r\n").at(-1) ?? "";
      if (!/^\d{3} /.test(last)) return;
      const code = Number(last.slice(0, 3));
      buffer = "";
      step += 1;
      const next = steps[step];
      if (next === undefined) {
        socket.end("QUIT\r\n");
        resolve(code);
        return;
      }
      socket.write(`${next}\r\n`);
    });
    socket.on("error", reject);
  });
}
test("defines an SMTP receiver in the form and takes recipients only for its addresses", async ({
  page,
  desk,
  signIn,
}) => {
  test.skip(remote, "The receiver of this test is the one of the development stack.");
  const { gamma } = desk.projects;
  await signIn();
  await page.goto("/");
  await openSettings(page, "Connections", gamma.name);
  const section = page.getByRole("region", { name: `Connections` });
  const name = `Receiver ${desk.run}`;
  const address = `receiver-${desk.run}@example.test`;
  await section.getByRole("button", { name: "Add connection" }).click();
  const form = section.locator("form.connection-form");
  await form.getByLabel("Type").selectOption({ label: "SMTP · incoming" });
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Receiving addresses").fill(address);
  // The receiver has no login, so there are no credentials to type.
  await expect(form.getByText("Credentials are stored sealed")).toHaveCount(0);
  await form.getByRole("button", { name: "Create connection" }).click();
  await expect(section.locator("li strong").filter({ hasText: name })).toBeVisible();
  // Until a test has made the connection ready, the receiver does not know the address.
  expect(await recipientCode(address)).toBe(550);
  await section.getByRole("button", { name: `Test ${name}` }).click();
  await expect(
    section.getByRole("listitem").filter({ hasText: name }).getByText("Ready"),
  ).toBeVisible();
  expect(await recipientCode(address)).toBe(250);
  expect(await recipientCode(address.toUpperCase())).toBe(250);
  expect(await recipientCode(`other-${desk.run}@example.test`)).toBe(550);
  await section.getByRole("button", { name: `Disable ${name}` }).click();
  await expect(
    section.getByRole("listitem").filter({ hasText: name }).getByText("Disabled"),
  ).toBeVisible();
  expect(await recipientCode(address)).toBe(550);
});
// A Mailjet connection is made in the form, shows up in the list of the project that the page is on, and its keys are
// not shown again. The keys are not real: the connection is not tested here, since a test calls Mailjet.
test("saves a Mailjet connection from the form into the list of the open project", async ({
  page,
  desk,
  signIn,
}) => {
  const { gamma } = desk.projects;
  await signIn();
  await page.goto("/");
  await openSettings(page, "Connections", gamma.name);
  const section = page.getByRole("region", { name: "Connections" });
  await section.getByRole("button", { name: "Add connection" }).click();
  const form = section.locator("form.connection-form");
  await form.getByLabel("Type").selectOption({ label: "Mailjet · outgoing" });
  const name = `Mailjet ${desk.run}`;
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Sender address").fill("hello@example.test");
  await form.getByLabel("Reply-to address").fill("hello@example.test");
  await form.getByLabel("Key", { exact: true }).fill("mailjet-key-for-e2e");
  await form.getByLabel("Secret key").fill("mailjet-secret-for-e2e");
  await form.getByRole("button", { name: "Create connection" }).click();
  await expect(form).toBeHidden();
  await expect(section.locator("li").filter({ hasText: name })).toBeVisible();
  await expect(section.locator("li").filter({ hasText: name })).toContainText("Not tested");
  // The keys are not part of what the page shows, also not after it is loaded again.
  await page.reload();
  await openSettings(page, "Connections", gamma.name);
  await expect(section.locator("li").filter({ hasText: name })).toBeVisible();
  expect(await page.content()).not.toContain("mailjet-secret-for-e2e");
});
