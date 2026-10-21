import { z } from "zod";
import { expect, fixture, test } from "./fixtures";
// A note names a person: the composer offers the people who may read the ticket, the name is put into the text, and
// the person is told. The person is a fixture operator who cannot sign in here, so the test asks the database.
test.describe.configure({ mode: "serial" });
const kinds = (email: string) =>
  z.object({ kinds: z.array(z.string()) }).parse(JSON.parse(fixture("notifications-of", email)))
    .kinds;
test("names a person in a note and tells them, and a note without a name tells nobody", async ({
  page,
  desk,
  signIn,
}) => {
  const ticket = desk.projects.alpha.tickets[0];
  const named = desk.sso.oidc;
  const mentions = (email: string) => kinds(email).filter((kind) => kind === "mention").length;
  const told = () => mentions(named) + mentions(desk.sso.saml);
  const before = told();
  await signIn();
  await page.goto(`/?ticket=${ticket}`);
  const panel = page.getByRole("region", { name: "Ticket" });
  await panel.getByRole("button", { name: "Internal note" }).click();
  // The picker is for notes only, and offers others, never the author.
  const picker = panel.getByLabel("Tell a person about this note");
  await expect(picker).toBeVisible();
  const options = await picker.locator("option").allTextContents();
  expect(options).not.toContain(`E2E operator ${desk.run}`);
  expect(options.filter((text) => text === `E2E SSO ${desk.run}`).length).toBeGreaterThanOrEqual(2);
  // A note without a name first.
  await panel.getByRole("textbox", { name: "Add a private note…" }).fill("Note for nobody");
  await panel.getByRole("button", { name: "Save note" }).click();
  await expect(panel.getByRole("article").filter({ hasText: "Note for nobody" })).toBeVisible();
  expect(told()).toBe(before);
  // Now with a name: the text gets the name, the list shows the person and can drop them again.
  await picker.selectOption({ index: 1 });
  const text = panel.getByRole("textbox", { name: "Add a private note…" });
  await expect(text).toHaveValue(`@E2E SSO ${desk.run} `);
  const list = panel.getByRole("list", { name: "People who are told about this note" });
  await expect(list).toContainText(`@E2E SSO ${desk.run}`);
  await list.getByRole("button", { name: `Do not tell E2E SSO ${desk.run}` }).click();
  await expect(list).toHaveCount(0);
  await picker.selectOption({ index: 1 });
  await text.press("End");
  await text.pressSequentially("please check");
  await panel.getByRole("button", { name: "Save note" }).click();
  await expect(panel.getByRole("article").filter({ hasText: "please check" })).toBeVisible();
  await expect(list).toHaveCount(0);
  // One of the two people with that name is told, once; the other is not.
  await expect.poll(told).toBe(before + 1);
});
