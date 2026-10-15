import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, mailpit, test } from "./fixtures";
// The customer's view of a ticket through a portal link that an operator
// creates: public conversation only, a reply that reaches the desk, and a link
// that stops working when it is disabled.
test.describe.configure({ mode: "serial" });
const detail = z.object({
  ticket: z.object({ status: z.string(), revision: z.number(), language: z.string() }),
  messages: z.array(
    z.object({ markdown: z.string(), authorType: z.string(), internal: z.boolean() }),
  ),
});
test("opens a ticket for its requester, takes a reply and ends with the link", async ({
  page,
  desk,
  signIn,
  browser,
  baseURL,
}) => {
  const ticketId = desk.projects.alpha.tickets[0];
  const note = `Private note ${randomUUID()}`;
  const answer = `Customer answer ${randomUUID()}`;
  await signIn();
  // A private note must never show up for the customer.
  const before = detail.parse(await (await page.request.get(`/api/v1/tickets/${ticketId}`)).json());
  expect(
    (
      await page.request.post(`/api/v1/tickets/${ticketId}/reply`, {
        data: {
          markdown: note,
          internal: true,
          language: before.ticket.language,
          expectedRevision: before.ticket.revision,
          idempotencyKey: randomUUID(),
        },
        headers: { origin: baseURL ?? "" },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/?ticket=${ticketId}`);
  const panel = page.getByRole("region", { name: "Ticket" });
  await panel.getByRole("button", { name: "Create portal link" }).click();
  const link = panel.getByLabel("Link to the customer's view");
  await expect(link).toBeVisible();
  const url = await link.inputValue();
  expect(url).toMatch(/\/portal\/[A-Za-z0-9_.-]{40,}$/);
  // The customer has no session.
  const context = await browser.newContext({ locale: "en-US" });
  const customer = await context.newPage();
  try {
    await customer.goto(url);
    await expect(customer.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(customer.getByRole("region", { name: "Conversation" })).toBeVisible();
    await expect(customer.getByText(note)).toHaveCount(0);
    await expect(customer.locator('meta[name="referrer"]')).toHaveAttribute(
      "content",
      "no-referrer",
    );
    await expect(customer.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const scan = await new AxeBuilder({ page: customer }).analyze();
    expect(scan.violations).toEqual([]);
    // A reply appears in the conversation as the customer's own message.
    await customer.getByLabel("Your reply").fill(answer);
    await customer.getByRole("button", { name: "Send reply" }).click();
    const own = customer.getByRole("article").filter({ hasText: answer });
    await expect(own).toBeVisible();
    await expect(own.getByText("You", { exact: true })).toBeVisible();
    // The desk shows it as a message of the requester, and the ticket is open.
    const after = detail.parse(
      await (await page.request.get(`/api/v1/tickets/${ticketId}`)).json(),
    );
    expect(after.ticket.status).toBe("open");
    expect(
      after.messages.some(
        (m) => m.markdown === answer && m.authorType === "customer" && !m.internal,
      ),
    ).toBe(true);
    // Disabling the link ends the access, and the page says only that it does not work.
    await panel.getByRole("button", { name: "Disable portal link" }).click();
    await expect(panel.getByText("Portal link disabled")).toBeVisible();
    await customer.reload();
    await expect(customer.getByRole("heading", { name: "This link does not work" })).toBeVisible();
    await expect(customer.getByText(answer)).toHaveCount(0);
  } finally {
    await context.close();
  }
});
test("keeps what a customer types before the page is ready", async ({
  page,
  desk,
  signIn,
  browser,
  baseURL,
}) => {
  const ticketId = desk.projects.alpha.tickets[1];
  const answer = `Early answer ${randomUUID()}`;
  await signIn();
  const grant = z.object({ url: z.string() }).parse(
    await (
      await page.request.post(`/api/v1/tickets/${ticketId}/portal-link`, {
        data: {},
        headers: { origin: baseURL ?? "" },
      })
    ).json(),
  );
  const context = await browser.newContext({ locale: "en-US" });
  const customer = await context.newPage();
  try {
    // The scripts of the page arrive late, as on a slow connection or a busy server.
    // Until they ran, the form is server HTML without handlers: a submit would
    // reload the page and hydration would reset the field.
    await context.route("**/_next/static/**/*.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
    await customer.goto(grant.url, { waitUntil: "commit" });
    const reply = customer.getByLabel("Your reply");
    await expect(reply).toBeVisible();
    await expect(reply).toBeDisabled();
    await reply.fill(answer);
    await customer.getByRole("button", { name: "Send reply" }).click();
    await expect(customer.getByRole("article").filter({ hasText: answer })).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await context.close();
  }
});
test("shows the page in German for a German browser and refuses an unknown link", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "de-DE" });
  const customer = await context.newPage();
  try {
    await customer.goto(`/portal/${"x".repeat(43)}`);
    await expect(
      customer.getByRole("heading", { name: "Dieser Link funktioniert nicht" }),
    ).toBeVisible();
    const scan = await new AxeBuilder({ page: customer }).analyze();
    expect(scan.violations).toEqual([]);
  } finally {
    await context.close();
  }
});
test("sends the customer a link in the reply and opens the conversation from it", async ({
  page,
  desk,
  signIn,
  browser,
  baseURL,
}) => {
  const ticketId = desk.projects.alpha.tickets[1];
  const answer = `Answer with link ${randomUUID()}`;
  const headers = { origin: baseURL ?? "" };
  await signIn();
  const settings = `/api/v1/projects/${desk.projects.alpha.id}/settings`;
  expect((await page.request.post(settings, { data: { portalLinks: true }, headers })).ok()).toBe(
    true,
  );
  try {
    const before = z
      .object({
        ticket: z.object({
          revision: z.number(),
          language: z.string(),
          subject: z.string(),
          requesterEmail: z.string(),
        }),
      })
      .parse(await (await page.request.get(`/api/v1/tickets/${ticketId}`)).json());
    expect(
      (
        await page.request.post(`/api/v1/tickets/${ticketId}/reply`, {
          data: {
            markdown: answer,
            language: before.ticket.language,
            expectedRevision: before.ticket.revision,
            idempotencyKey: randomUUID(),
          },
          headers,
        })
      ).status(),
    ).toBe(202);
    const found = z.object({
      messages: z.array(z.object({ ID: z.string(), Subject: z.string() })),
    });
    // Searched by the text of this answer: earlier tests may have mailed the same ticket.
    let id = "";
    await expect
      .poll(
        async () => {
          id =
            found
              .parse(
                await (
                  await page.request.get(
                    `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${before.ticket.requesterEmail} "${answer}"`)}`,
                  )
                ).json(),
              )
              .messages.find((message) => message.Subject === `Re: ${before.ticket.subject}`)?.ID ??
            "";
          return id;
        },
        { timeout: 45_000, intervals: [1000] },
      )
      .not.toBe("");
    const mail = z
      .object({ Text: z.string(), HTML: z.string() })
      .parse(await (await page.request.get(`${mailpit}/api/v1/message/${id}`)).json());
    // A token is 22 characters, a dot and 43 characters; nothing after it belongs to it.
    const url = /https?:\/\/\S+?\/portal\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/.exec(
      mail.Text,
    )?.[0];
    expect(url).toBeDefined();
    expect(mail.HTML).toContain(url);
    expect(mail.Text).toContain("View this request online and reply:");
    // The customer opens it without a session and sees the answer.
    const context = await browser.newContext({ locale: "en-US" });
    const customer = await context.newPage();
    try {
      await customer.goto(url ?? "");
      await expect(customer.getByText(answer)).toBeVisible();
    } finally {
      await context.close();
    }
  } finally {
    await page.request.post(settings, { data: { portalLinks: false }, headers });
  }
});
