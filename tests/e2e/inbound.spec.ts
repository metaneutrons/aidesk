import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { z } from "zod";
import { expect, mailpit, test } from "./fixtures";
// A complete round trip through real protocols: the customer writes to the
// project's mailbox (GreenMail SMTP), the worker reads it over IMAP, the
// operator answers in the desk (delivered to Mailpit), and the customer's
// reply to that answer lands in the same ticket.
test.describe.configure({ mode: "serial" });
test.skip(({ browserName }) => browserName !== "chromium", "Protocol round trip; runs once.");
const smtp = nodemailer.createTransport({
  host: process.env.E2E_MAILBOX_HOST ?? "127.0.0.1",
  port: 3025,
  secure: false,
  ignoreTLS: true,
});
const ticketList = z.array(z.object({ id: z.string(), subject: z.string(), status: z.string() }));
const conversation = z.object({
  ticket: z.object({ status: z.string() }),
  messages: z.array(z.object({ markdown: z.string(), authorType: z.string() })),
});
test("turns a customer mail into a ticket and threads the reply to our answer", async ({
  page,
  desk,
  signIn,
}) => {
  const customer = `${desk.prefix}-customer@example.test`;
  const mailboxAddress = `${desk.prefix}-alpha@support.local`;
  const subject = `Inbound ${randomUUID()}`;
  await smtp.sendMail({
    from: `Kim Customer <${customer}>`,
    to: mailboxAddress,
    subject,
    text: "The export stops at file 3.\n\n-- \nKim",
  });
  await signIn();
  let ticketId = "";
  await expect
    .poll(
      async () => {
        const list = ticketList.parse(
          await (
            await page.request.get(`/api/v1/tickets?project=${desk.projects.alpha.id}`)
          ).json(),
        );
        ticketId = list.find((ticket) => ticket.subject === subject)?.id ?? "";
        return ticketId;
      },
      { timeout: 45_000, intervals: [1000] },
    )
    .not.toBe("");
  await page.goto(`/?ticket=${ticketId}`);
  const panel = page.getByRole("region", { name: "Ticket" });
  await expect(panel.getByText("The export stops at file 3.")).toBeVisible();
  await expect(panel.getByText("Kim", { exact: true })).toHaveCount(0);
  await expect(panel.getByText(`To Kim Customer <${customer}>`)).toBeVisible();
  const answer = `Answer ${randomUUID()}`;
  await panel.getByRole("textbox", { name: "Write your reply in Markdown…" }).fill(answer);
  await panel.getByRole("button", { name: "Send reply" }).click();
  await expect(
    panel.getByRole("article").filter({ hasText: answer }).getByText("Accepted by mail transport"),
  ).toBeVisible({ timeout: 30_000 });
  const found = z
    .object({ messages: z.array(z.object({ ID: z.string(), Snippet: z.string() })) })
    .parse(
      await (
        await page.request.get(
          `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${customer}`)}`,
        )
      ).json(),
    )
    .messages.find((message) => message.Snippet.includes(answer));
  const headers = z
    .record(z.string(), z.array(z.string()))
    .parse(
      await (await page.request.get(`${mailpit}/api/v1/message/${found?.ID ?? ""}/headers`)).json(),
    );
  const ourId = headers["Message-Id"]?.[0] ?? "";
  expect(ourId).toMatch(/^<.+@.+>$/);
  const followUp = `Follow-up ${randomUUID()}`;
  await smtp.sendMail({
    from: `Kim Customer <${customer}>`,
    to: mailboxAddress,
    subject: `Re: ${subject}`,
    inReplyTo: ourId,
    references: [ourId],
    text: `${followUp}\n\nOn Mon, ${desk.projects.alpha.name} wrote:\n> ${answer}`,
  });
  await expect
    .poll(
      async () =>
        conversation
          .parse(await (await page.request.get(`/api/v1/tickets/${ticketId}`)).json())
          .messages.map((message) => message.markdown),
      { timeout: 45_000, intervals: [1000] },
    )
    .toContain(followUp);
  const thread = conversation.parse(
    await (await page.request.get(`/api/v1/tickets/${ticketId}`)).json(),
  );
  expect(thread.ticket.status).toBe("open");
  expect(thread.messages.map((message) => message.authorType)).toEqual([
    "customer",
    "human",
    "customer",
  ]);
});
