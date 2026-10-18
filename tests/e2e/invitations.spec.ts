import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Inviting an operator by address in the settings: the person is added with the role, the answer says what happened
// to the mail, and a second invitation of the same address adds rights and creates nobody. The account carries the
// prefix of the run, so that the fixture removes it with the rest.
test.describe.configure({ mode: "serial" });
const operatorsSchema = z.array(
  z.object({
    email: z.string(),
    grants: z.array(z.object({ projectId: z.string(), actions: z.array(z.string()) })),
  }),
);
test("invites an operator by address and adds rights when the address is used again", async ({
  page,
  desk,
  signIn,
}) => {
  const { alpha } = desk.projects;
  const email = `${desk.prefix}-invited@aidesk.local`;
  const rightsOf = async () =>
    operatorsSchema
      .parse(await (await page.request.get("/api/v1/operators")).json())
      .find((entry) => entry.email === email)
      ?.grants.find((grant) => grant.projectId === alpha.id)?.actions;
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const form = page.locator("form.invite");
  await expect(form).toBeVisible();
  await form.getByLabel("Project").selectOption({ label: alpha.name });
  await form.getByLabel("Name", { exact: true }).fill("Robin Invited");
  await form.getByLabel("Email address").fill(email);
  await form.getByLabel("Role").selectOption({ label: "Read" });
  // No mail is asked for here: the mail path is covered by the tests of the worker.
  await form.getByLabel("Tell the person by mail").uncheck();
  await form.getByRole("button", { name: "Invite" }).click();
  await expect(form.getByRole("status")).toContainText("The person was added.");
  await expect(form.getByRole("status")).toContainText("No mail was sent.");
  await expect(form.getByRole("status")).toContainText("cannot sign in");
  await expect.poll(rightsOf).toEqual(expect.arrayContaining(["project.read", "ticket.read"]));
  expect((await rightsOf())?.includes("ticket.reply")).toBe(false);
  // The same address again with a bigger role: nobody is created, the rights are added.
  await form.getByLabel("Name", { exact: true }).fill("Robin Invited");
  await form.getByLabel("Email address").fill(email);
  await form.getByLabel("Role").selectOption({ label: "Respond" });
  await form.getByRole("button", { name: "Invite" }).click();
  await expect(form.getByRole("status")).toContainText("already belongs to an operator");
  await expect.poll(rightsOf).toEqual(expect.arrayContaining(["ticket.reply"]));
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
});
