import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, mailpit, openPasswordSignIn, remote, test } from "./fixtures";
import { totp } from "./totp";
const conversation = (page: Page) => page.getByRole("region", { name: "Ticket" });
async function openInbox(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Inbox" }).click();
}
test("rejects a wrong password and opens a deep-linked ticket after sign-in", async ({
  page,
  desk,
}) => {
  const ticket = desk.projects.alpha.tickets[0];
  await page.goto(`/?ticket=${ticket}`);
  await expect(page).toHaveURL(/\/login\?next=/);
  await openPasswordSignIn(page);
  await page.getByLabel("Email address").fill(desk.email);
  await page.getByLabel("Password").fill("wrong-password-for-e2e");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Sign-in failed" })).toBeVisible();
  await page.getByLabel("Password").fill(desk.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Authentication code").fill(totp(desk.totpSecret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?ticket=${ticket}$`));
  await expect(conversation(page).getByRole("heading", { level: 2 })).toHaveText(
    `${desk.projects.alpha.name} request 1`,
  );
});
test("shows only granted projects and filters without losing the open draft", async ({
  page,
  desk,
  signIn,
}) => {
  const { alpha, beta, hidden } = desk.projects;
  await signIn();
  await openInbox(page);
  const list = page.getByRole("region", { name: "Inbox" });
  await expect(list.getByRole("button", { name: alpha.name })).toHaveCount(2);
  await expect(list.getByRole("button", { name: beta.name })).toHaveCount(2);
  await expect(page.getByText(hidden.name)).toHaveCount(0);
  await list.getByRole("button", { name: `${alpha.name} request 1` }).click();
  await conversation(page)
    .getByRole("textbox", { name: /Write your reply|Add a private note/ })
    .fill("Draft that survives filtering");
  await page.getByRole("button", { name: "All projects" }).click();
  await expect(page.getByRole("checkbox", { name: alpha.name })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: hidden.name })).toHaveCount(0);
  await page.getByRole("checkbox", { name: beta.name }).check();
  await expect(list.getByRole("button", { name: alpha.name })).toHaveCount(0);
  await expect(list.getByRole("button", { name: beta.name })).toHaveCount(2);
  await expect(conversation(page).getByRole("heading", { level: 2 })).toHaveText(
    `${alpha.name} request 1`,
  );
  await expect(
    conversation(page).getByRole("textbox", { name: /Write your reply|Add a private note/ }),
  ).toHaveValue("Draft that survives filtering");
});
test("denies access to a project without a grant", async ({ page, desk, signIn }) => {
  const ticket = desk.projects.hidden.tickets[0];
  await signIn();
  await page.goto(`/?ticket=${ticket}`);
  await expect(
    page.getByRole("alert").filter({ hasText: "You do not have access to this ticket." }),
  ).toBeVisible();
  expect((await page.request.get(`/api/v1/tickets/${ticket}`)).status()).toBe(404);
  const projects = z
    .array(z.object({ id: z.string() }))
    .parse(await (await page.request.get("/api/v1/projects")).json());
  expect(projects.map((project) => project.id)).not.toContain(desk.projects.hidden.id);
});
test("records an internal note and delivers a reply without it", async ({ page, desk, signIn }) => {
  test.skip(
    remote,
    "A deployment takes mail and jobs only when its schedule calls the worker, and has no test mailbox.",
  );
  const ticket = desk.projects.alpha.tickets[0];
  const recipient = `${desk.prefix}-alpha-1@example.test`;
  const note = `Internal marker ${randomUUID()}`;
  const reply = `Reply marker ${randomUUID()}`;
  await signIn();
  await page.goto(`/?ticket=${ticket}`);
  const panel = conversation(page);
  await panel.getByRole("button", { name: "Internal note" }).click();
  await panel.getByRole("textbox", { name: "Add a private note…" }).fill(note);
  await panel.getByRole("button", { name: "Save note" }).click();
  const recorded = panel.getByRole("article").filter({ hasText: note });
  await expect(recorded).toBeVisible();
  await expect(recorded.getByText("Internal", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    panel.getByText(`From ${desk.projects.alpha.name} <${desk.prefix}-alpha@support.local>`),
  ).toBeVisible();
  await expect(panel.getByText(`To Customer 1 <${recipient}>`)).toBeVisible();
  await panel.getByRole("textbox", { name: "Write your reply in Markdown…" }).fill(reply);
  await panel.getByRole("button", { name: "Send reply" }).click();
  const sent = panel.getByRole("article").filter({ hasText: reply });
  await expect(sent).toBeInViewport();
  // The open ticket follows the worker's outcome without a reload.
  await expect(sent.getByText("Accepted by mail transport")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("Waiting for customer")).toBeVisible();
  const messages = z.object({
    messages: z.array(z.object({ markdown: z.string(), deliveryState: z.string() })),
  });
  await expect
    .poll(
      async () =>
        messages
          .parse(await (await page.request.get(`/api/v1/tickets/${ticket}`)).json())
          .messages.find((message) => message.markdown === reply)?.deliveryState,
      { timeout: 30_000 },
    )
    .toBe("sent");
  const search = z
    .object({ messages: z.array(z.object({ ID: z.string() })) })
    .parse(
      await (
        await page.request.get(
          `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
        )
      ).json(),
    );
  expect(search.messages).toHaveLength(1);
  const [captured] = search.messages;
  const mail = z
    .object({ Text: z.string(), HTML: z.string() })
    .parse(
      await (await page.request.get(`${mailpit}/api/v1/message/${captured?.ID ?? ""}`)).json(),
    );
  expect(mail.Text).toContain(reply);
  expect(mail.HTML).toContain(reply);
  expect(mail.Text + mail.HTML).not.toContain(note);
  // A mutation without the application origin is rejected even with a session.
  const foreign = await page.request.post(`/api/v1/tickets/${ticket}/reply`, {
    data: {},
    headers: { origin: "https://attacker.example" },
  });
  expect(foreign.status()).toBe(403);
});
test("threads consecutive replies to the customer message", async ({ page, desk, signIn }) => {
  test.skip(
    remote,
    "A deployment takes mail and jobs only when its schedule calls the worker, and has no test mailbox.",
  );
  const ticket = desk.projects.alpha.tickets[1];
  const recipient = `${desk.prefix}-alpha-2@example.test`;
  const customer = `<${desk.prefix}-alpha-2@example.test>`;
  const headers = z.record(z.string(), z.array(z.string()));
  async function deliver(text: string) {
    const panel = conversation(page);
    await panel.getByRole("textbox", { name: "Write your reply in Markdown…" }).fill(text);
    await panel.getByRole("button", { name: "Send reply" }).click();
    await expect(
      panel.getByRole("article").filter({ hasText: text }).getByText("Accepted by mail transport"),
    ).toBeVisible({ timeout: 30_000 });
    const found = z
      .object({ messages: z.array(z.object({ ID: z.string(), Snippet: z.string() })) })
      .parse(
        await (
          await page.request.get(
            `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
          )
        ).json(),
      )
      .messages.filter((message) => message.Snippet.includes(text));
    expect(found).toHaveLength(1);
    return headers.parse(
      await (
        await page.request.get(`${mailpit}/api/v1/message/${found[0]?.ID ?? ""}/headers`)
      ).json(),
    );
  }
  await signIn();
  await page.goto(`/?ticket=${ticket}`);
  const first = await deliver(`First threaded reply ${randomUUID()}`);
  expect(first["In-Reply-To"]).toEqual([customer]);
  expect(first.References).toEqual([customer]);
  const firstId = first["Message-Id"]?.[0];
  expect(firstId).toMatch(/^<[^@]+@[^>]+>$/);
  const second = await deliver(`Second threaded reply ${randomUUID()}`);
  expect(second["In-Reply-To"]).toEqual([customer]);
  expect(second.References).toEqual([`${customer} ${firstId ?? ""}`]);
});
test("hides the composer and rejects replies in a read-only project", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const ticket = desk.projects.beta.tickets[0];
  await signIn();
  await page.goto(`/?ticket=${ticket}`);
  await expect(conversation(page).getByRole("heading", { level: 2 })).toHaveText(
    `${desk.projects.beta.name} request 1`,
  );
  await expect(
    conversation(page).getByRole("textbox", { name: /Write your reply|Add a private note/ }),
  ).toHaveCount(0);
  const response = await page.request.post(`/api/v1/tickets/${ticket}/reply`, {
    data: {
      markdown: "Must not be sent",
      internal: false,
      language: "de",
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    },
    headers: { origin: baseURL ?? "" },
  });
  expect(response.status()).toBe(403);
});
test("keeps drafts per ticket across navigation and reload", async ({ page, desk, signIn }) => {
  const { alpha } = desk.projects;
  await signIn();
  await openInbox(page);
  const list = page.getByRole("region", { name: "Inbox" });
  await list.getByRole("button", { name: `${alpha.name} request 2` }).click();
  await conversation(page)
    .getByRole("textbox", { name: /Write your reply|Add a private note/ })
    .fill("Unsent draft for request 2");
  await list.getByRole("button", { name: `${alpha.name} request 1` }).click();
  await expect(
    conversation(page).getByRole("textbox", { name: /Write your reply|Add a private note/ }),
  ).toHaveValue("");
  await list.getByRole("button", { name: `${alpha.name} request 2` }).click();
  await expect(
    conversation(page).getByRole("textbox", { name: /Write your reply|Add a private note/ }),
  ).toHaveValue("Unsent draft for request 2");
  await page.reload();
  await expect(
    conversation(page).getByRole("textbox", { name: /Write your reply|Add a private note/ }),
  ).toHaveValue("Unsent draft for request 2");
});
test("moves focus into the new-project dialog and back", async ({ page, desk, signIn }) => {
  await signIn();
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "New project" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest("[role=dialog]") !== null))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  const name = `E2E Created ${desk.run}`;
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByLabel("Project address").fill(`${desk.prefix}-created`);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "All projects" }).click();
  await expect(page.getByRole("checkbox", { name })).toBeVisible();
});
test.describe("with a German browser", () => {
  test.use({ locale: "de-DE" });
  test("follows the browser language until the operator chooses one", async ({ page, signIn }) => {
    await signIn();
    await page.goto("/");
    const title = page.getByRole("heading", { level: 1 });
    await expect(title).toHaveText("Übersicht");
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await page.getByLabel("Sprache").selectOption("en");
    await expect(title).toHaveText("Overview");
    await page.reload();
    await expect(title).toHaveText("Overview");
    await page.getByLabel("Language").selectOption("auto");
    await expect(title).toHaveText("Übersicht");
  });
});
test.describe("with a dark system appearance", () => {
  test.use({ colorScheme: "dark" });
  test("follows the system and keeps an explicit choice", async ({ page, signIn }) => {
    await signIn();
    await page.goto("/");
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
    await expect.poll(background).toBe("rgb(21, 23, 32)");
    const light = page.getByRole("button", { name: "Light appearance" });
    await light.click();
    await expect(light).toHaveAttribute("aria-pressed", "true");
    await expect.poll(background).toBe("rgb(246, 247, 251)");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(background).toBe("rgb(246, 247, 251)");
    await page.getByRole("button", { name: "Use system appearance" }).click();
    await expect.poll(background).toBe("rgb(21, 23, 32)");
  });
});
test.describe("before hydration", () => {
  test.use({ javaScriptEnabled: false });
  test("keeps the sign-in form disabled so typed input cannot be lost", async ({ page }) => {
    test.skip(
      remote,
      "A production build has no password field in the page before the script runs.",
    );
    await page.goto("/login");
    await expect(page.getByLabel("Email address")).toBeDisabled();
    await expect(page.getByLabel("Password")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
  });
});
test("enables the sign-in form after hydration", async ({ page }) => {
  test.skip(
    remote,
    "A production build shows the password field after a button, see the sign-in test.",
  );
  await page.goto("/login");
  await expect(page.getByLabel("Email address")).toBeEnabled();
  await expect(page.getByLabel("Password")).toBeEnabled();
});
test("searches every authorized ticket by text and never shows another project", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const { alpha, hidden } = desk.projects;
  const word = `needle${randomUUID().slice(0, 8)}`;
  await signIn();
  // A word that only a private note of one ticket contains.
  const before = z
    .object({ ticket: z.object({ revision: z.number(), language: z.string() }) })
    .parse(await (await page.request.get(`/api/v1/tickets/${alpha.tickets[0]}`)).json());
  expect(
    (
      await page.request.post(`/api/v1/tickets/${alpha.tickets[0]}/reply`, {
        data: {
          markdown: `Check the ${word} setting`,
          internal: true,
          language: before.ticket.language,
          expectedRevision: before.ticket.revision,
          idempotencyKey: randomUUID(),
        },
        headers: { origin: baseURL ?? "" },
      })
    ).ok(),
  ).toBe(true);
  await openInbox(page);
  const list = page.getByRole("region", { name: "Inbox" });
  await list.getByRole("textbox", { name: "Search" }).fill(word);
  await expect(list.getByRole("status")).toHaveText("1 match in all authorized projects");
  const row = list.getByRole("button", { name: new RegExp(`${alpha.name} request 1`) });
  await expect(row.getByText(`Check the ${word} setting`)).toBeVisible();
  await row.click();
  await expect(conversation(page).getByRole("heading", { level: 2 })).toHaveText(
    `${alpha.name} request 1`,
  );
  // The other project's tickets exist but are not found, and nothing about them is counted.
  await list.getByRole("textbox", { name: "Search" }).fill(hidden.name);
  await expect(list.getByText("No ticket matches this text")).toBeVisible();
  await list.getByRole("textbox", { name: "Search" }).fill(alpha.name);
  await expect(list.getByRole("status")).toHaveText("2 matches in all authorized projects");
  // One character still filters the loaded list.
  await list.getByRole("textbox", { name: "Search" }).fill("q");
  await expect(list.getByRole("status")).toHaveCount(0);
});
