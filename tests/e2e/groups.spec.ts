import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Single rights and groups in the settings: a right of an operator is ticked and taken away again, and a group is
// made, given a member, shown in the rights of that member and deleted. The operator is one that only this run has.
test.describe.configure({ mode: "serial" });
const operatorsSchema = z.array(
  z.object({
    email: z.string(),
    grants: z.array(z.object({ projectId: z.string(), actions: z.array(z.string()) })),
    groups: z.array(z.object({ name: z.string() })),
    effective: z.array(z.object({ projectId: z.string(), actions: z.array(z.string()) })),
  }),
);
const groupsSchema = z.array(
  z.object({ id: z.string(), name: z.string(), members: z.array(z.object({ email: z.string() })) }),
);
test("ticks a single right, and makes a group with a member", async ({ page, desk, signIn }) => {
  const { alpha } = desk.projects;
  const person = `E2E plain ${desk.run}`;
  const group = `E2E group ${desk.run}`;
  const operator = async () =>
    operatorsSchema
      .parse(await (await page.request.get("/api/v1/operators")).json())
      .find((entry) => entry.email === desk.plain);
  const groups = async () =>
    groupsSchema.parse(
      await (await page.request.get(`/api/v1/projects/${alpha.id}/groups`)).json(),
    );
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const row = page.getByRole("row").filter({ hasText: person });
  const rights = row.locator("details.rights").filter({ hasText: `in ${alpha.name}` });
  const section = page
    .locator("section.groups")
    .filter({ has: page.getByRole("heading", { name: `Groups of ${alpha.name}` }) });
  try {
    // A single right.
    await rights.locator("summary").click();
    const notes = rights.getByLabel("Write notes");
    await expect(notes).not.toBeChecked();
    await notes.click();
    await expect.poll(async () => (await operator())?.grants[0]?.actions).toEqual(["ticket.note"]);
    await expect(rights.getByLabel("Write notes")).toBeChecked();
    await rights.getByLabel("Write notes").click();
    await expect.poll(async () => (await operator())?.grants).toEqual([]);
    // A group with a member.
    await expect(section).toBeVisible();
    await section.getByLabel("Name of the group").fill(group);
    await section.getByLabel("Reply to customers").click();
    await section.getByRole("button", { name: "Create a group" }).click();
    const item = section.getByRole("listitem").filter({ hasText: group }).first();
    await expect(item).toBeVisible();
    await item.getByLabel(`Add an operator to ${group}`).selectOption({ label: person });
    await item.getByRole("button", { name: "Add", exact: true }).click();
    await expect(item.getByText(person)).toBeVisible();
    expect((await groups()).find((entry) => entry.name === group)?.members).toEqual([
      { email: desk.plain },
    ]);
    await expect
      .poll(async () => (await operator())?.effective[0]?.actions)
      .toEqual(expect.arrayContaining(["project.read", "ticket.read", "ticket.reply"]));
    expect((await operator())?.grants).toEqual([]);
    await expect(rights).toContainText("Also through the groups");
    await rights.locator("summary").click();
    await expect(rights).toContainText(group);
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .exclude(".design-frame")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
    // Removing the member takes the right away, and so does deleting the group.
    await item.getByRole("button", { name: `Remove ${person} from ${group}` }).click();
    await expect.poll(async () => (await operator())?.effective).toEqual([]);
    await item.getByRole("button", { name: `Delete ${group}` }).click();
    await expect(item.getByText("The members lose what the group gave them.")).toBeVisible();
    await item.getByRole("button", { name: `Yes, delete ${group}` }).click();
    await expect
      .poll(async () => (await groups()).some((entry) => entry.name === group))
      .toBe(false);
  } finally {
    for (const left of (await groups()).filter((entry) => entry.name === group))
      await page.request.post(`/api/v1/projects/${alpha.id}/groups/${left.id}/delete`, {
        headers: { origin: new URL(page.url()).origin },
        data: {},
      });
    await page.request.post(`/api/v1/operators/${(await operatorId()) ?? ""}/grants`, {
      headers: { origin: new URL(page.url()).origin },
      data: { projectId: alpha.id, actions: [] },
    });
  }
  async function operatorId() {
    const list = z
      .array(z.object({ id: z.string(), email: z.string() }))
      .parse(await (await page.request.get("/api/v1/operators")).json());
    return list.find((entry) => entry.email === desk.plain)?.id;
  }
});
