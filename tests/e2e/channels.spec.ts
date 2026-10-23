import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// A channel of a messenger: added on the settings page, with the address kept sealed and shown as its host only, and
// the subject of the ticket off until it is switched on. Nothing is sent to the messenger here: the address is one that
// resolves and that this test never calls.
const listed = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    format: z.string(),
    withSubject: z.boolean(),
    events: z.array(z.string()),
    secretSet: z.boolean(),
  }),
);
test("adds a channel, shows only its host, and switches the subject on and off", async ({
  page,
  desk,
  signIn,
}) => {
  const { alpha } = desk.projects;
  const name = `Channel ${desk.run}`;
  const key = `KEY${desk.run}${"z".repeat(12)}`;
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: `Webhooks of ${alpha.name}` });
  await section.getByRole("button", { name: "Add a channel" }).click();
  const form = section.locator("form.connection-form");
  await form.getByLabel("Name of the channel").fill(name);
  await form.getByLabel("Messenger").selectOption({ label: "Slack" });
  await form
    .getByLabel("Address of the incoming webhook")
    .fill(`https://hooks.slack.com/services/T0000/B0000/${key}`);
  // The subject is off, and a channel needs at least one event.
  await expect(form.getByLabel("Name the subject of the ticket in the message")).not.toBeChecked();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  await form.getByRole("button", { name: "Add channel" }).click();
  await expect(section.getByText(/The channel was added/)).toBeVisible();
  const row = section.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("Slack · https://hooks.slack.com");
  // Neither the page nor the API shows the key of the address.
  await expect(page.getByText(key)).toHaveCount(0);
  const list = async () =>
    listed.parse(await (await page.request.get(`/api/v1/projects/${alpha.id}/webhooks`)).json());
  const text = await (await page.request.get(`/api/v1/projects/${alpha.id}/webhooks`)).text();
  expect(text).not.toContain(key);
  expect((await list()).find((hook) => hook.name === name)).toMatchObject({
    format: "slack",
    url: "https://hooks.slack.com",
    withSubject: false,
    secretSet: true,
    events: ["ticket.created", "ticket.assigned", "ticket.overdue", "draft.created"],
  });
  // The person holds the right to approve, so the switch applies at once, in both directions.
  const subject = row.getByLabel(`Name the subject in ${name}`);
  await expect(subject).not.toBeChecked();
  // The switch follows the server, so it changes when the answer is in.
  await subject.click();
  await expect(subject).toBeChecked();
  await expect
    .poll(async () => (await list()).find((hook) => hook.name === name)?.withSubject)
    .toBe(true);
  await subject.click();
  await expect(subject).not.toBeChecked();
  await expect
    .poll(async () => (await list()).find((hook) => hook.name === name)?.withSubject)
    .toBe(false);
});
test("refuses an address that is not https and says which field is wrong", async ({
  page,
  desk,
  signIn,
}) => {
  const { alpha } = desk.projects;
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: `Webhooks of ${alpha.name}` });
  await section.getByRole("button", { name: "Add a channel" }).click();
  const form = section.locator("form.connection-form");
  await form.getByLabel("Name of the channel").fill(`Plain ${desk.run}`);
  await form
    .getByLabel("Address of the incoming webhook")
    .fill("http://hooks.example.test/services/x");
  await form.getByRole("button", { name: "Add channel" }).click();
  await expect(form.getByRole("alert")).toContainText("The channel could not be added");
  await expect(form.getByRole("alert")).toContainText("HTTPS is required");
});
