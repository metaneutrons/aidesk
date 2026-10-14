import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Under the default review policy an agent's reply to a customer is a draft that
// a person sends or discards.
test.describe.configure({ mode: "serial" });
test("shows an agent's draft, discards one and sends one", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const { alpha: beta } = desk.projects;
  const ticket = beta.tickets[1];
  const headers = { origin: baseURL ?? "" };
  await signIn();
  const issued = z.object({ token: z.string(), id: z.uuid() }).parse(
    await (
      await page.request.post(`/api/v1/projects/${beta.id}/agents`, {
        headers,
        data: { name: "Drafter", actions: ["project.read", "ticket.read", "ticket.reply"] },
      })
    ).json(),
  );
  const agentReply = async (markdown: string) => {
    const detail = z
      .object({ ticket: z.object({ revision: z.number(), language: z.string() }) })
      .parse(await (await page.request.get(`/api/v1/tickets/${ticket}`)).json());
    const response = await page.request.post(`/api/v1/tickets/${ticket}/reply`, {
      headers: { authorization: `Bearer ${issued.token}` },
      data: {
        markdown,
        internal: false,
        expectedRevision: detail.ticket.revision,
        language: detail.ticket.language,
        idempotencyKey: randomUUID(),
        resolve: false,
      },
    });
    expect(response.status(), await response.text()).toBe(202);
    expect(z.object({ draft: z.boolean() }).parse(await response.json()).draft).toBe(true);
  };
  try {
    const discarded = `Discard me ${randomUUID()}`;
    const kept = `Send me ${randomUUID()}`;
    await agentReply(discarded);
    await page.goto(`/?ticket=${ticket}`);
    const panel = page.getByRole("region", { name: "Ticket" });
    const draft = (text: string) => panel.getByRole("article").filter({ hasText: text });
    await expect(draft(discarded).getByText("Draft by an agent, not sent")).toBeVisible();
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .analyze();
    expect(scan.violations.map((violation) => violation.id)).toEqual([]);
    await draft(discarded).getByRole("button", { name: "Discard draft" }).click();
    await expect(draft(discarded).getByText("Draft discarded")).toBeVisible();
    await expect(draft(discarded).getByRole("button", { name: "Send draft" })).toHaveCount(0);
    // A draft shows where its links lead; one without links shows nothing of the kind.
    await expect(draft(discarded).getByText("Links in this draft")).toHaveCount(0);
    const spoofed = `Link draft ${randomUUID()}`;
    await agentReply(`${spoofed} [https://bank.example/login](https://evil.example/steal)`);
    await page.reload();
    const checked = draft(spoofed);
    await expect(checked.getByText("Links in this draft: text and address")).toBeVisible();
    await expect(checked.locator("code")).toHaveText("https://evil.example/steal");
    await expect(
      checked.getByText("The text names another address than the link goes to"),
    ).toBeVisible();
    const linkScan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .exclude("[data-base-ui-focus-guard]")
      .analyze();
    expect(linkScan.violations.map((violation) => violation.id)).toEqual([]);
    await checked.getByRole("button", { name: "Discard draft" }).click();
    await expect(checked.getByText("Draft discarded")).toBeVisible();
    // A second draft is sent by a person; the mail is queued and goes out.
    await agentReply(kept);
    await page.reload();
    await draft(kept).getByRole("button", { name: "Send draft" }).click();
    await expect(
      draft(kept).getByText(/^(Queued for delivery|Accepted by mail transport)$/),
    ).toBeVisible();
    await expect(draft(kept).getByText("Draft by an agent, not sent")).toHaveCount(0);
    // The agent has no way to send it itself.
    const messages = z
      .object({ messages: z.array(z.object({ id: z.string(), markdown: z.string() })) })
      .parse(await (await page.request.get(`/api/v1/tickets/${ticket}`)).json());
    const sent = messages.messages.find((message) => message.markdown === kept);
    const own = await page.request.post(`/api/v1/messages/${sent?.id ?? ""}/send`, {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(own.status()).toBe(403);
  } finally {
    await page.request.post(`/api/v1/agents/${issued.id}/revoke`, { headers });
  }
});
