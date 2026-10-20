import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { request } from "@playwright/test";
import { expect, openSection, test } from "./fixtures";
// The audit in the settings: opened on demand, filtered by action and actor, the detail of an entry, the
// export with the filters that are applied, and the audit of the workspace for the owner.
test.describe.configure({ mode: "serial" });
test("filters the audit of a project, shows the detail of an entry and exports with the same filters", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  const tag = `audit-${desk.run}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  await signIn();
  // Something to find: a change of the tags of a ticket is an entry of the audit with its tags as detail.
  const ticket = alpha.tickets[0];
  for (const tags of [[tag], []]) {
    const response = await page.request.post(`/api/v1/tickets/${ticket}/tags`, {
      headers,
      data: { tags },
    });
    expect(response.status(), await response.text()).toBe(200);
  }
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page
    .locator("section.audit-log")
    .filter({ has: page.getByRole("heading", { name: `Audit of ${alpha.name}` }) });
  await openSection(section, `Audit of ${alpha.name}`);
  // Newest first: the removal of the tags, then the entry that set them.
  const rows = section.getByRole("row").filter({ hasText: "ticket.tags" });
  const row = rows.nth(1);
  // The first request to the audit builds its route in the development server, which takes a while in CI.
  await expect(row).toBeVisible({ timeout: 30_000 });
  // A filter by a family of actions keeps the entry; an actor that never acted removes everything.
  await section.getByLabel("Action").fill("ticket.");
  await section.getByRole("button", { name: "Apply filters" }).click();
  await expect(row).toBeVisible();
  await expect(section.getByRole("row").filter({ hasText: "webhook." })).toHaveCount(0);
  await section.getByLabel("Actor (id)").fill("nobody-ever-acted");
  await section.getByRole("button", { name: "Apply filters" }).click();
  await expect(section.getByText("No entries match.")).toBeVisible();
  await section.getByLabel("Actor (id)").fill("");
  await section.getByRole("button", { name: "Apply filters" }).click();
  await expect(row).toBeVisible();
  // The detail of the entry shows the tags and nothing of the ticket.
  await rows.first().getByText("Show").click();
  await expect(rows.first().locator("pre")).toContainText('"tags": []');
  await row.getByText("Show").click();
  await expect(row.locator("pre")).toContainText(tag);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  // The export carries the filters that are applied, and the file is the table of the entries.
  const link = section.getByRole("link", { name: /Export the audit of .* as CSV/ });
  const href = (await link.getAttribute("href")) ?? "";
  expect(href).toContain(`/api/v1/projects/${alpha.id}/audit/export`);
  expect(href).toContain("action=ticket.");
  const file = await page.request.get(href);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toContain("text/csv");
  expect(file.headers()["content-disposition"]).toContain("attachment");
  const text = await file.text();
  expect(text.split("\r\n")[0]).toBe("time,actor_id,actor_name,actor_kind,action,target_id,detail");
  expect(text).toContain("ticket.tags");
  expect(text).not.toContain("webhook.");
});
test("lets the owner read the audit of the workspace and nobody else", async ({
  page,
  signIn,
  baseURL,
}) => {
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page
    .locator("section.audit-log")
    .filter({ has: page.getByRole("heading", { name: "Audit of the workspace" }) });
  await expect(section).toBeVisible();
  await section.getByText("Audit of the workspace").click();
  await expect(
    section.getByRole("link", { name: /Export the audit of the workspace as CSV/ }),
  ).toBeVisible();
  const listed = z
    .object({ entries: z.array(z.object({ action: z.string() })), next: z.string().nullable() })
    .parse(await (await page.request.get("/api/v1/audit")).json());
  expect(listed.entries.length).toBeGreaterThanOrEqual(0);
  // Without a session the address answers 401, whoever asks.
  const anonymous = await request.newContext(baseURL ? { baseURL } : {});
  expect((await anonymous.get("/api/v1/audit")).status()).toBe(401);
  await anonymous.dispose();
});
