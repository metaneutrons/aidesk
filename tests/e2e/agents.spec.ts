import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Assigning a ticket to a managed agent, the state of its work and the stops that a person
// sets for one ticket, a project and the workspace.
test.describe.configure({ mode: "serial" });
test("assigns a ticket to a managed agent and stops and resumes it", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  await signIn();
  const created = await page.request.post(`/api/v1/projects/${alpha.id}/agents/managed`, {
    data: { name: `Helper ${desk.run}`, actions: ["ticket.read"] },
    headers,
  });
  expect(created.status()).toBe(201);
  await page.goto(`/?ticket=${alpha.tickets[0]}`);
  const panel = page.getByRole("region", { name: "Ticket" });
  await expect(panel.locator(".assignment")).toContainText("Not assigned");
  await panel.getByRole("combobox", { name: "Change assignee" }).focus();
  await panel
    .getByRole("combobox", { name: "Change assignee" })
    .selectOption({ label: `Helper ${desk.run} (AI agent)` });
  await expect(panel.getByText(`Assigned to Helper ${desk.run} (AI agent)`)).toBeVisible();
  // The worker may already have ended the run (the AI task of the project is not set up).
  await expect(panel.locator(".ai-state")).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // A stop on the ticket, and letting the agent continue.
  await panel.getByRole("button", { name: "Stop agent" }).click();
  await expect(panel.locator(".ai-state")).toHaveAttribute("data-state", "stopped");
  await panel.getByRole("button", { name: "Let agent continue" }).click();
  await expect(panel.locator(".ai-state")).not.toHaveAttribute("data-state", "stopped");
  // The API says the same.
  const detail = z
    .object({
      assignee: z.object({ managed: z.boolean(), name: z.string() }).nullable(),
      aiWork: z.object({ state: z.string(), stoppedBy: z.string().nullable() }).nullable(),
    })
    .parse(await (await page.request.get(`/api/v1/tickets/${alpha.tickets[0]}`)).json());
  expect(detail.assignee).toMatchObject({ managed: true, name: `Helper ${desk.run}` });
  expect(detail.aiWork?.stoppedBy).toBeNull();
  // Handing the ticket back to nobody.
  await panel
    .getByRole("combobox", { name: "Change assignee" })
    .selectOption({ label: "Not assigned" });
  await expect(panel.locator(".assignment")).toContainText("Not assigned");
  await expect(panel.locator(".ai-state")).toHaveCount(0);
});
test("stops the agents of a project from the settings and shows the switches of the workspace", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  await signIn();
  const agent = z.object({ id: z.uuid() }).parse(
    await (
      await page.request.post(`/api/v1/projects/${alpha.id}/agents/managed`, {
        data: { name: `Second ${desk.run}`, actions: ["ticket.read"] },
        headers,
      })
    ).json(),
  );
  expect(
    (
      await page.request.post(`/api/v1/tickets/${alpha.tickets[1]}/assign`, {
        data: { userId: null, agentId: agent.id },
        headers,
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: `AI agents: ${alpha.name}` });
  await expect(section.getByText("The agents of this project work.")).toBeVisible();
  await section.getByRole("button", { name: "Stop all agents" }).click();
  await expect(section.getByText("The agents of this project are stopped.")).toBeVisible();
  // Nothing is queued while a stop holds.
  await expect(section.getByRole("button", { name: "Queue waiting tickets" })).toBeDisabled();
  const stopped = z
    .object({
      aiWork: z.object({ state: z.string(), stoppedBy: z.string().nullable() }).nullable(),
    })
    .parse(await (await page.request.get(`/api/v1/tickets/${alpha.tickets[1]}`)).json());
  expect(stopped.aiWork).toMatchObject({ state: "stopped", stoppedBy: "project" });
  // The switches of the whole workspace are for the owner and are shown. They are global to the
  // installation, so a test that sets one would stop the agents and the mail of the tests that run
  // beside it; the API tests set them.
  const workspace = page.getByRole("region", { name: "Whole workspace" });
  await expect(workspace.getByRole("checkbox", { name: "Stop all AI agents" })).not.toBeChecked();
  await expect(
    workspace.getByRole("checkbox", { name: "Pause all outgoing mail" }),
  ).not.toBeChecked();
  // Letting the agents work again queues nothing; the waiting tickets are queued on request.
  await section.getByRole("button", { name: "Let agents work again" }).click();
  await expect(section.getByText("The agents of this project work.")).toBeVisible();
  await section.getByRole("button", { name: "Queue waiting tickets" }).click();
  await expect(section.getByText(/tickets? queued/)).toBeVisible();
});
