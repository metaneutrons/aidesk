import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { expect, test } from "./fixtures";
// A walkthrough of the operator and of the customer with what a mouse-free, zoomed or narrow
// reader needs: German and English, light and dark, the keyboard alone, a window of 320 px and the
// same at 200 % zoom. It finds what the rules of the scanner can find and what a script can measure
// (the focus can be seen, nothing scrolls sideways, every control is reached by Tab); a screen
// reader and the judgement of a person are not part of it and are named in the qualification.
const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function audit(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(tags)
    .exclude("[data-base-ui-focus-guard]")
    .exclude(".design-frame")
    .exclude(".original-frame")
    .analyze();
  return result.violations.map((violation) => ({
    rule: violation.id,
    targets: violation.nodes.map((node) => node.target.join(" ")),
  }));
}
// How far the page is wider than the window: zero when nothing scrolls sideways.
const overflow = (page: Page) =>
  page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
// The element that has the focus draws something that shows it.
async function focusShown(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return false;
    const style = getComputedStyle(element);
    const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
    const shadow = style.boxShadow !== "none";
    return outline || shadow;
  });
}
test.describe("operator in German with a dark system", () => {
  test.use({ locale: "de-DE", colorScheme: "dark" });
  test("works a ticket from the overview to a sent reply, without violations on the way", async ({
    page,
    desk,
    signIn,
  }) => {
    await signIn();
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Übersicht");
    expect(await audit(page)).toEqual([]);
    await page.goto(`/?ticket=${desk.projects.alpha.tickets[0]}`);
    const panel = page.getByRole("region", { name: "Ticket" });
    await expect(
      panel.getByRole("textbox", { name: "Schreibe deine Antwort in Markdown…" }),
    ).toBeVisible();
    expect(await audit(page)).toEqual([]);
    for (const toggle of ["Übersetzen", "Wissen"]) {
      await panel.getByText(toggle, { exact: true }).first().click();
      expect(await audit(page)).toEqual([]);
    }
    await panel
      .getByRole("textbox", { name: "Schreibe deine Antwort in Markdown…" })
      .fill(`Antwort ${randomUUID()}`);
    expect(await audit(page)).toEqual([]);
    await page.getByRole("navigation").getByRole("button", { name: "Einstellungen" }).click();
    await expect(page.getByRole("heading", { name: "Operatoren" })).toBeVisible();
    expect(await audit(page)).toEqual([]);
  });
});
test.describe("a narrow window and zoom", () => {
  for (const [name, width, height] of [
    ["320 px wide", 320, 640],
    ["200 % zoom of a 1280 px window", 640, 512],
  ] as const)
    test(`operator and customer ${name}: nothing scrolls sideways and nothing is lost`, async ({
      page,
      desk,
      signIn,
      baseURL,
      browser,
    }) => {
      await signIn();
      await page.setViewportSize({ width, height });
      for (const path of ["/", `/?ticket=${desk.projects.alpha.tickets[0]}`]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        expect(await overflow(page), `${path} at ${name}`).toBeLessThanOrEqual(1);
        expect(await audit(page)).toEqual([]);
      }
      await page
        .getByRole("button", { name: "Back" })
        .click()
        .catch(() => undefined);
      await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("heading", { name: "Operators" })).toBeVisible();
      expect(await overflow(page), `settings at ${name}`).toBeLessThanOrEqual(1);
      // The customer's page, from a link, with a message that holds a long address that cannot break
      // (an answer with a link in it is one that other specs of the run leave on this ticket).
      const target = desk.projects.alpha.tickets[1];
      const current = z
        .object({ ticket: z.object({ revision: z.number(), language: z.string() }) })
        .parse(await (await page.request.get(`/api/v1/tickets/${target}`)).json());
      const sent = await page.request.post(`/api/v1/tickets/${target}/reply`, {
        headers: { origin: baseURL ?? "" },
        data: {
          markdown: `https://example.test/portal/${"a1b2c3d4".repeat(12)}`,
          expectedRevision: current.ticket.revision,
          idempotencyKey: randomUUID(),
          language: current.ticket.language,
        },
      });
      expect(sent.status()).toBe(202);
      await page.goto(`/?ticket=${target}`);
      await page.getByRole("button", { name: "Create portal link" }).click();
      const url = await page.getByLabel("Link to the customer's view").inputValue();
      const context = await browser.newContext({ locale: "de-DE", viewport: { width, height } });
      const customer = await context.newPage();
      try {
        await customer.goto(url);
        await expect(customer.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await overflow(customer), `portal at ${name}`).toBeLessThanOrEqual(1);
        expect(await audit(customer)).toEqual([]);
        await customer.getByLabel("Deine Antwort").fill("Danke für die Hilfe.");
        expect(await overflow(customer)).toBeLessThanOrEqual(1);
      } finally {
        await context.close();
      }
      expect(baseURL).toBeTruthy();
    });
});
test("the desk can be used with the keyboard alone", async ({
  page,
  desk,
  signIn,
  browserName,
}) => {
  // Safari does not move the focus to buttons and links with Tab unless a setting says so.
  test.skip(browserName === "webkit", "Tab does not reach buttons in Safari by default.");
  await signIn();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Overview");
  // The first Tab lands on something that can be seen, and the navigation is reached in order.
  await page.keyboard.press("Tab");
  expect(await focusShown(page)).toBe(true);
  const reached: string[] = [];
  for (let step = 0; step < 40 && reached.length < 20; step += 1) {
    const label = await page.evaluate(() => {
      const element = document.activeElement;
      return element?.getAttribute("aria-label") ?? element?.textContent.trim().slice(0, 40) ?? "";
    });
    if (label) reached.push(label);
    await page.keyboard.press("Tab");
    expect(await focusShown(page), `focus after ${String(step + 1)} tabs`).toBe(true);
  }
  for (const wanted of ["Inbox", "Settings", "Sign out"])
    expect(reached.join("|")).toContain(wanted);
  // Open a ticket with Enter and write a note with the keyboard.
  await page.getByRole("navigation").getByRole("button", { name: "Inbox" }).focus();
  await page.keyboard.press("Enter");
  const row = page
    .getByRole("region", { name: "Inbox" })
    .getByRole("button", { name: new RegExp(`${desk.projects.alpha.name} request 1`) })
    .first();
  await expect(row).toBeVisible();
  await row.focus();
  await page.keyboard.press("Enter");
  const field = page.getByRole("textbox", { name: "Write your reply in Markdown…" });
  await expect(field).toBeVisible();
  await field.focus();
  await page.keyboard.type("A note written with the keyboard");
  await expect(field).toHaveValue("A note written with the keyboard");
  // The dialog of a new project traps the focus and gives it back.
  await page.getByRole("button", { name: "New project" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "New project" })).toBeVisible();
  const inside = () =>
    page.evaluate(() => document.activeElement?.closest("[role=dialog]") !== null);
  // The focus moves into the dialog by itself, and Tab does not take it out again.
  await expect.poll(inside).toBe(true);
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press("Tab");
    // The guards at the edges hand the focus back to the dialog a moment later.
    await expect.poll(inside, { message: `after ${String(step + 1)} tabs` }).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "")).toBe(
    "New project",
  );
  expect(desk.run).toBeTruthy();
});
test("the desk and the customer page log no error in the console", async ({
  page,
  desk,
  signIn,
  browser,
}) => {
  const seen: string[] = [];
  const watch = (target: Page) => {
    target.on("console", (message) => {
      // The sandboxed frames of the mail previews make the browser say this in the development
      // stack, although their text holds no script; the source is not traced.
      if (
        message.type() === "error" &&
        !message.text().startsWith("Blocked script execution in 'about:srcdoc'")
      )
        seen.push(message.text().slice(0, 240));
    });
    target.on("pageerror", (error) => seen.push(`pageerror: ${error.message.slice(0, 240)}`));
  };
  watch(page);
  await signIn();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto(`/?ticket=${desk.projects.alpha.tickets[0]}`);
  await expect(page.getByRole("region", { name: "Ticket" })).toBeVisible();
  await page.getByText("Knowledge", { exact: true }).first().click();
  await page.getByText("Translate", { exact: true }).first().click();
  await page.getByRole("button", { name: "Create portal link" }).click();
  const url = await page.getByLabel("Link to the customer's view").inputValue();
  for (const view of ["Junk", "Settings"])
    await page.getByRole("navigation").getByRole("button", { name: view }).click();
  await expect(page.getByRole("heading", { name: "Operators" })).toBeVisible();
  const context = await browser.newContext({ locale: "en-US" });
  const customer = await context.newPage();
  watch(customer);
  try {
    await customer.goto(url);
    await expect(customer.getByRole("heading", { level: 1 })).toBeVisible();
  } finally {
    await context.close();
  }
  expect(seen).toEqual([]);
});
