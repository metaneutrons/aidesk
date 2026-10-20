import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import nodemailer from "nodemailer";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Erasing data: a mail that arrives over the real protocol becomes a ticket, the ticket is erased from its header
// after the numbers were shown, and everything about a requester is erased from the settings. The mails are the
// test's own, so nothing of the fixture is touched.
test.describe.configure({ mode: "serial" });
test.skip(({ browserName }) => browserName !== "chromium", "Protocol round trip; runs once.");
const smtp = nodemailer.createTransport({
  host: process.env.E2E_MAILBOX_HOST ?? "127.0.0.1",
  port: 3025,
  secure: false,
  ignoreTLS: true,
});
const ticketList = z.array(z.object({ id: z.string(), subject: z.string() }));
test("erases a ticket and a requester after showing what goes", async ({ page, desk, signIn }) => {
  const { alpha } = desk.projects;
  const customer = `${desk.prefix}-erase@example.test`;
  const mailbox = `${desk.prefix}-alpha@support.local`;
  const subjects = [
    `Erase one ${randomUUID()}`,
    `Erase two ${randomUUID()}`,
    `Erase three ${randomUUID()}`,
  ];
  const ids = new Map<string, string>();
  await signIn();
  const tickets = async () =>
    ticketList.parse(await (await page.request.get(`/api/v1/tickets?project=${alpha.id}`)).json());
  const arrived = async (subject: string) => {
    await expect
      .poll(async () => (await tickets()).find((ticket) => ticket.subject === subject)?.id ?? "", {
        timeout: 45_000,
        intervals: [1000],
      })
      .not.toBe("");
    ids.set(subject, (await tickets()).find((ticket) => ticket.subject === subject)?.id ?? "");
  };
  for (const subject of subjects)
    await smtp.sendMail({
      from: `Kim Eraser <${customer}>`,
      to: mailbox,
      subject,
      text: "Please erase me.",
      attachments: [{ filename: "note.txt", content: `note ${subject}` }],
    });
  for (const subject of subjects) await arrived(subject);
  // The first ticket from its header: what goes is shown, and nothing happens before the confirmation.
  await page.goto(`/?ticket=${ids.get(subjects[0] ?? "") ?? ""}`);
  const panel = page.getByRole("region", { name: "Ticket" });
  await panel.getByRole("button", { name: "Erase this ticket…" }).click();
  const group = panel.getByRole("group", { name: "Erase this ticket" });
  await expect(group.getByText("1 ticket", { exact: true })).toBeVisible();
  await expect(group.getByText("1 message", { exact: true })).toBeVisible();
  await expect(group.getByText("1 attached file")).toBeVisible();
  await expect(group.getByText(/Backups of the installation keep the data/)).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .analyze();
  expect(scan.violations.map((violation) => violation.id)).toEqual([]);
  await group.getByRole("button", { name: "Cancel" }).click();
  expect((await tickets()).some((ticket) => ticket.subject === subjects[0])).toBe(true);
  await panel.getByRole("button", { name: "Erase this ticket…" }).click();
  await panel
    .getByRole("group", { name: "Erase this ticket" })
    .getByRole("button", { name: "Erase for good" })
    .click();
  await expect
    .poll(async () => (await tickets()).some((ticket) => ticket.subject === subjects[0]))
    .toBe(false);
  expect(
    (await page.request.get(`/api/v1/tickets/${ids.get(subjects[0] ?? "") ?? ""}`)).status(),
  ).toBe(404);
  // Everything about the requester, from the settings: the address is shown with the counts.
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.locator("section.erase-requester").filter({
    has: page.getByRole("heading", { name: `Erase a requester in ${alpha.name}` }),
  });
  await section.getByLabel("Address of the requester").fill(customer.toUpperCase());
  await section.getByRole("button", { name: "Show what would be erased" }).click();
  const shown = section.getByRole("group", { name: `Erasing ${customer}` });
  await expect(shown.getByText("2 tickets", { exact: true })).toBeVisible();
  await shown.getByRole("button", { name: "Erase for good" }).click();
  await expect(section.getByRole("status")).toContainText("Erased: 2 tickets");
  await expect
    .poll(
      async () => (await tickets()).filter((ticket) => subjects.includes(ticket.subject)).length,
    )
    .toBe(0);
});
