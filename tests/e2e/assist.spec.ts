import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// The draft button of the composer. The first test goes through the real server,
// where no AI task is set up and the button says so. The others answer the request
// themselves, to see what the field and the buttons do with a draft.
const request = z.object({
  mode: z.enum(["reply", "note"]),
  instruction: z.string().optional(),
  current: z.string().optional(),
});
test("says that AI drafts are not set up, and leaves the field alone", async ({
  page,
  desk,
  signIn,
}) => {
  await signIn();
  await page.goto(`/?ticket=${desk.projects.alpha.tickets[0]}`);
  const field = page.getByRole("textbox", { name: "Write your reply in Markdown…" });
  await field.fill("My own words");
  await page.getByRole("button", { name: "Draft with AI" }).click();
  await expect(page.locator(".conversation-error")).toContainText(
    "AI drafts are not set up for this project",
  );
  await expect(field).toHaveValue("My own words");
  await expect(page.getByRole("button", { name: "Undo AI draft" })).toHaveCount(0);
});
test("puts a draft into the field as text to edit, and undoes it", async ({
  page,
  desk,
  signIn,
}) => {
  const ticket = desk.projects.alpha.tickets[0];
  const sent: z.infer<typeof request>[] = [];
  await page.route(`**/api/v1/tickets/${ticket}/draft-assist`, async (route) => {
    sent.push(request.parse(route.request().postDataJSON()));
    await route.fulfill({ json: { text: "Dear Kim,\n\nit ships tomorrow.", truncated: false } });
  });
  await signIn();
  await page.goto(`/?ticket=${ticket}`);
  const field = page.getByRole("textbox", { name: "Write your reply in Markdown…" });
  await page.getByRole("button", { name: "Draft with AI" }).click();
  await expect(field).toHaveValue("Dear Kim,\n\nit ships tomorrow.");
  await expect(page.getByRole("status").filter({ hasText: "AI draft inserted" })).toBeVisible();
  expect(sent[0]).toEqual({ mode: "reply" });
  // The draft is text like any other: it can be edited, and it was not sent.
  await field.fill("Dear Kim,\n\nit ships on Friday.");
  await expect(page.getByRole("article").filter({ hasText: "it ships tomorrow" })).toHaveCount(0);
  // With text in the field and an instruction, both go with the request.
  await page.getByLabel("Instruction for this draft (optional)").fill("Mention the 5 % voucher");
  await page.getByRole("button", { name: "Draft with AI" }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual({
    mode: "reply",
    instruction: "Mention the 5 % voucher",
    current: "Dear Kim,\n\nit ships on Friday.",
  });
  // Undo brings back what was in the field before the last draft.
  await page.getByRole("button", { name: "Undo AI draft" }).click();
  await expect(field).toHaveValue("Dear Kim,\n\nit ships on Friday.");
  await expect(page.getByRole("button", { name: "Undo AI draft" })).toHaveCount(0);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
});
test("drafts a note in note mode and tells when the draft was cut", async ({
  page,
  desk,
  signIn,
}) => {
  const ticket = desk.projects.alpha.tickets[0];
  const sent: z.infer<typeof request>[] = [];
  await page.route(`**/api/v1/tickets/${ticket}/draft-assist`, async (route) => {
    sent.push(request.parse(route.request().postDataJSON()));
    await route.fulfill({ json: { text: "Customer waits for the parcel.", truncated: true } });
  });
  await signIn();
  await page.goto(`/?ticket=${ticket}`);
  await page.getByRole("button", { name: "Internal note", exact: true }).click();
  await page.getByRole("button", { name: "Draft with AI" }).click();
  await expect(page.getByRole("textbox", { name: "Add a private note…" })).toHaveValue(
    "Customer waits for the parcel.",
  );
  await expect(
    page.getByRole("status").filter({ hasText: "cut at the length limit" }),
  ).toBeVisible();
  expect(sent).toEqual([{ mode: "note" }]);
});
test("shows what each failure of a draft means", async ({ page, desk, signIn }) => {
  const ticket = desk.projects.alpha.tickets[0];
  let answer = { status: 429, error: "ai_budget_exceeded" };
  await page.route(`**/api/v1/tickets/${ticket}/draft-assist`, async (route) => {
    await route.fulfill({ status: answer.status, json: { error: answer.error } });
  });
  await signIn();
  await page.goto(`/?ticket=${ticket}`);
  const button = page.getByRole("button", { name: "Draft with AI" });
  for (const [status, error, message] of [
    [429, "ai_budget_exceeded", "The daily limit of the AI task for drafts is used up."],
    [504, "ai_timeout", "The AI did not answer in time."],
    [502, "ai_provider_error", "The AI could not write a draft."],
    [
      409,
      "ai_model_unavailable",
      "The provider does not offer the model of the AI task for drafts.",
    ],
    [503, "ai_rate_limited", "The provider limits requests or is busy right now."],
    [402, "ai_quota_exhausted", "The account at the provider has no credit or quota left."],
    [409, "ai_disabled", "AI drafts are not set up for this project."],
    [500, "unavailable", "The AI could not write a draft."],
  ] as const) {
    answer = { status, error };
    await button.click();
    await expect(page.locator(".conversation-error")).toContainText(message);
  }
});
test("drops a draft that arrives after the person moved to another ticket", async ({
  page,
  desk,
  signIn,
}) => {
  const [first, second] = desk.projects.alpha.tickets;
  await signIn();
  const subject = z
    .object({ ticket: z.object({ subject: z.string() }) })
    .parse(await (await page.request.get(`/api/v1/tickets/${second}`)).json()).ticket.subject;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let answered = false;
  await page.route(`**/api/v1/tickets/${first}/draft-assist`, async (route) => {
    await gate;
    await route.fulfill({ json: { text: "LATE DRAFT", truncated: false } });
    answered = true;
  });
  await page.goto(`/?ticket=${first}`);
  await page.getByRole("button", { name: "Draft with AI" }).click();
  await expect(page.getByRole("button", { name: "Drafting…" })).toBeDisabled();
  // Moving to the other ticket inside the page keeps the page and its state.
  await page.locator(".ticket-row").filter({ hasText: subject }).first().click();
  await expect(page.getByRole("region", { name: "Ticket" })).toContainText(subject);
  release();
  await expect.poll(() => answered).toBe(true);
  await page.waitForTimeout(300);
  await expect(page.getByRole("textbox", { name: "Write your reply in Markdown…" })).toHaveValue(
    "",
  );
  await expect(page.getByText("AI draft inserted")).toHaveCount(0);
});
