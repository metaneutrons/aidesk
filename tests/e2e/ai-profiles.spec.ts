import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// AI task profiles: a connection to a model provider is defined through the API,
// the settings page sets the profile of a task (model, limits, the switch that lets
// ticket content leave the system), and the page never shows the key.
test.describe.configure({ mode: "serial" });
const profileList = z.array(
  z.object({
    task: z.string(),
    version: z.number(),
    model: z.string().nullable(),
    enabled: z.boolean(),
    timeoutSeconds: z.number(),
  }),
);
test("sets the profile of a task on the settings page and switches it on and off", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  const connection = `E2E AI ${desk.run}`;
  await signIn();
  const created = await page.request.post(`/api/v1/projects/${alpha.id}/connections`, {
    headers,
    data: {
      kind: "anthropic",
      direction: "ai",
      name: connection,
      config: {},
      secret: { apiKey: "sk-e2e-never-shown-key" },
    },
  });
  expect(created.status(), await created.text()).toBeLessThan(300);
  const read = async () =>
    profileList
      .parse(await (await page.request.get(`/api/v1/projects/${alpha.id}/ai-profiles`)).json())
      .find((entry) => entry.task === "reply.draft");
  expect(await read()).toMatchObject({ version: 0, enabled: false, model: null });
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: `AI tasks of ${alpha.name}` });
  const task = section.getByRole("group", { name: "Draft a reply to the customer" });
  // The task that reads images is offered like the others.
  await expect(
    section.getByRole("group", { name: "Read images and scanned PDF files for agents" }),
  ).toBeVisible();
  await expect(task.getByLabel("Model provider")).toBeVisible();
  // What a person who chooses a model should know, for a draft and for a reading.
  await expect(task.getByText(/Smaller models follow them more often/)).toBeVisible();
  await expect(
    section
      .getByRole("group", { name: "Read images and scanned PDF files for agents" })
      .getByText(/can misread characters and figures/),
  ).toBeVisible();
  await task.getByLabel("Model provider").selectOption({ label: `${connection} (Anthropic)` });
  await expect(task.getByRole("button", { name: "Save task" })).toBeDisabled();
  await task.getByLabel("Model", { exact: true }).fill("model-e2e");
  await task.getByLabel("Timeout in seconds").fill("45");
  await task.getByRole("button", { name: "Save task" }).click();
  await expect(section.getByText("The task was saved.")).toBeVisible();
  expect(await read()).toMatchObject({
    version: 1,
    enabled: false,
    model: "model-e2e",
    timeoutSeconds: 45,
  });
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // The owner may approve, so switching on is applied at once, and the switch says
  // what it does.
  await expect(section.getByText(/needs a person who may approve changes/).first()).toBeVisible();
  await task.getByLabel("Allow this task to send ticket content to the provider").check();
  await task.getByRole("button", { name: "Save task" }).click();
  await expect(section.getByText("The task was saved.")).toBeVisible();
  expect(await read()).toMatchObject({ version: 2, enabled: true });
  // Switching off is a change like any other.
  await task.getByLabel("Allow this task to send ticket content to the provider").uncheck();
  await task.getByRole("button", { name: "Save task" }).click();
  await expect(section.getByText("The task was saved.")).toBeVisible();
  expect(await read()).toMatchObject({ version: 3, enabled: false });
  // The key was never on the page or in the answers.
  await expect(page.getByText("sk-e2e-never-shown-key")).toHaveCount(0);
  expect(
    await (await page.request.get(`/api/v1/projects/${alpha.id}/connections`)).text(),
  ).not.toContain("sk-e2e-never-shown-key");
});
