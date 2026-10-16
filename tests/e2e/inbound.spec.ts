import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
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
    attachments: [
      { filename: "export.log", content: "line 1\nline 2\n" },
      { filename: "fix.exe", content: Buffer.from("MZ") },
    ],
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
  // The log is downloadable; the executable is listed as not stored.
  const files = panel.getByRole("list", { name: "Attachments" });
  await expect(files.getByText("fix.exe: not stored, file type not allowed")).toBeVisible();
  const log = files.getByRole("link", { name: "export.log" });
  const download = await page.request.get((await log.getAttribute("href")) ?? "");
  expect(download.headers()["content-disposition"]).toContain('filename="export.log"');
  expect(await download.text()).toBe("line 1\nline 2\n");
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
  // An acknowledgement of the product is not part of the thread under test; other specs of the run
  // switch it on for the shared project for a while.
  expect(
    thread.messages
      .map((message) => message.authorType)
      .filter((authorType) => authorType !== "system"),
  ).toEqual(["customer", "human", "customer"]);
});
test("keeps spam out of the inbox and moves tickets to and from junk", async ({
  page,
  desk,
  signIn,
}) => {
  const spamSubject = `Cheap offer ${randomUUID()}`;
  await smtp.sendMail({
    from: `Spam Sender <${desk.prefix}-spam@example.test>`,
    to: `${desk.prefix}-alpha@support.local`,
    subject: spamSubject,
    text: "Buy now.",
    headers: { "X-Spam-Flag": "YES" },
  });
  await signIn();
  const junkList = z.array(z.object({ id: z.string(), kind: z.string(), subject: z.string() }));
  await expect
    .poll(
      async () =>
        junkList
          .parse(await (await page.request.get("/api/v1/junk")).json())
          .some((item) => item.subject === spamSubject),
      { timeout: 45_000, intervals: [1000] },
    )
    .toBe(true);
  const inbox = () =>
    page.request
      .get(`/api/v1/tickets?project=${desk.projects.alpha.id}`)
      .then(async (response) => ticketList.parse(await response.json()));
  expect((await inbox()).some((ticket) => ticket.subject === spamSubject)).toBe(false);
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Junk" }).click();
  const junk = page.getByRole("region", { name: "Junk" });
  await junk.getByRole("button", { name: new RegExp(spamSubject) }).click();
  const preview = page.getByRole("article", { name: "Junk preview" });
  await expect(preview.getByText("Buy now.")).toBeVisible();
  await expect(preview.getByText("Marked by the spam filter")).toHaveCount(0);
  await expect(junk.getByText("Marked by the spam filter").first()).toBeVisible();
  await preview.getByRole("button", { name: "Not junk" }).click();
  await expect(junk.getByRole("button", { name: new RegExp(spamSubject) })).toHaveCount(0);
  let restoredId = "";
  await expect
    .poll(
      async () => {
        restoredId = (await inbox()).find((ticket) => ticket.subject === spamSubject)?.id ?? "";
        return restoredId;
      },
      { timeout: 45_000, intervals: [1000] },
    )
    .not.toBe("");
  // The restored ticket can be moved to junk again and back.
  await page.goto(`/?ticket=${restoredId}`);
  await page
    .getByRole("region", { name: "Ticket" })
    .getByRole("button", { name: "Move to junk" })
    .click();
  await expect
    .poll(async () => (await inbox()).some((ticket) => ticket.id === restoredId))
    .toBe(false);
  await page.getByRole("navigation").getByRole("button", { name: "Junk" }).click();
  await junk.getByRole("button", { name: new RegExp(spamSubject) }).click();
  await expect(preview.getByText("Buy now.")).toBeVisible();
  await preview.getByRole("button", { name: "Not junk" }).click();
  await expect
    .poll(async () => (await inbox()).some((ticket) => ticket.id === restoredId))
    .toBe(true);
});
test("acknowledges a new ticket once switched on in settings", async ({ page, desk, signIn }) => {
  const customer = `${desk.prefix}-ack@example.test`;
  const subject = `Acknowledge ${randomUUID()}`;
  await signIn();
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", {
    name: `Configuration of ${desk.projects.alpha.name}`,
  });
  const toggle = section.getByLabel("Send an acknowledgement for each new ticket");
  // Another spec may have left it on; Save is enabled only for a change.
  if (!(await toggle.isChecked())) {
    await toggle.check();
    await section.getByRole("button", { name: "Save", exact: true }).click();
    await expect(section.getByText("Saved.")).toBeVisible();
  }
  await expect(toggle).toBeChecked();
  try {
    await smtp.sendMail({
      from: `Lee Customer <${customer}>`,
      to: `${desk.prefix}-alpha@support.local`,
      subject,
      text: "Is the export fixed?",
    });
    const found = z.object({
      messages: z.array(z.object({ ID: z.string(), Subject: z.string() })),
    });
    let id = "";
    await expect
      .poll(
        async () => {
          id =
            found
              .parse(
                await (
                  await page.request.get(
                    `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${customer}`)}`,
                  )
                ).json(),
              )
              .messages.find((message) => message.Subject === `Re: ${subject}`)?.ID ?? "";
          return id;
        },
        { timeout: 45_000, intervals: [1000] },
      )
      .not.toBe("");
    const headers = z
      .record(z.string(), z.array(z.string()))
      .parse(await (await page.request.get(`${mailpit}/api/v1/message/${id}/headers`)).json());
    expect(headers["Auto-Submitted"]).toEqual(["auto-replied"]);
    expect(headers["In-Reply-To"]?.[0]).toMatch(/^<.+@example\.test>$/);
    const tickets = ticketList.parse(
      await (await page.request.get(`/api/v1/tickets?project=${desk.projects.alpha.id}`)).json(),
    );
    const ticket = tickets.find((entry) => entry.subject === subject);
    // An acknowledgement is not an answer: the ticket stays open.
    expect(ticket?.status).toBe("open");
    await page.goto(`/?ticket=${ticket?.id ?? ""}`);
    await expect(
      page.getByRole("region", { name: "Ticket" }).getByText("Acknowledgement", { exact: true }),
    ).toBeVisible();
  } finally {
    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    const back = page.getByRole("region", {
      name: `Configuration of ${desk.projects.alpha.name}`,
    });
    await back.getByLabel("Send an acknowledgement for each new ticket").uncheck();
    await back.getByRole("button", { name: "Save", exact: true }).click();
    await expect(back.getByText("Saved.")).toBeVisible();
  }
});
test("previews the original mail safely and returns focus when it closes", async ({
  page,
  desk,
  signIn,
}) => {
  const customer = `${desk.prefix}-preview@example.test`;
  const subject = `Preview ${randomUUID()}`;
  // A mail with a script, a form, a remote image and an image of its own.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await smtp.sendMail({
    from: `Pat Customer <${customer}>`,
    to: `${desk.prefix}-alpha@support.local`,
    subject,
    text: "Plain fallback of the preview mail.",
    html: [
      "<p>Formatted <b>original</b> text.</p>",
      "<script>document.title='executed'</script>",
      '<form action="https://evil.test"><input name="x"></form>',
      '<img src="https://tracker.test/pixel.gif" alt="tracker">',
      '<img src="cid:logo@example.test" alt="own image">',
    ].join(""),
    attachments: [
      { filename: "logo.png", content: png, cid: "logo@example.test", contentType: "image/png" },
    ],
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
  const opener = panel.getByRole("button", { name: "Preview original" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Preview original" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("1 remote image is not loaded")).toBeVisible();
  const frame = dialog.frameLocator("iframe");
  await expect(frame.getByText("Formatted original text.")).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .include("[role=dialog]")
    .exclude(".original-frame")
    .analyze();
  expect(scan.violations).toEqual([]);
  await expect(frame.locator("img[alt='own image']")).toHaveAttribute("src", /^data:image\/png/);
  await expect(frame.locator("script, form, input")).toHaveCount(0);
  await expect(frame.locator("img[alt='tracker']")).not.toHaveAttribute("src", /.+/);
  // The frame has no scripts: the title the script would have set stays unchanged.
  await expect(page).not.toHaveTitle("executed");
  const html = z
    .object({ html: z.string() })
    .parse(
      await (
        await page.request.get(
          `/api/v1/messages/${await messageId(page, ticketId)}/original/preview`,
        )
      ).json(),
    ).html;
  expect(html).toContain("Content-Security-Policy");
  // The plain text is the fallback.
  await dialog.getByRole("button", { name: "Plain text" }).click();
  await expect(dialog.getByText("Plain fallback of the preview mail.")).toBeVisible();
  // Escape closes the dialog and focus returns to the button that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
async function messageId(page: Page, ticket: string): Promise<string> {
  const detail = z
    .object({ messages: z.array(z.object({ id: z.string(), authorType: z.string() })) })
    .parse(await (await page.request.get(`/api/v1/tickets/${ticket}`)).json());
  return detail.messages.find((message) => message.authorType === "customer")?.id ?? "";
}
