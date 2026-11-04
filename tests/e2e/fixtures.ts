import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test as base, expect, type Page } from "@playwright/test";
import { z } from "zod";
import { createIdpUser, deleteIdpUser } from "./keycloak";
import { totp } from "./totp";
const projectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  tickets: z.tuple([z.uuid(), z.uuid()]),
});
const deskSchema = z.object({
  run: z.string().regex(/^[a-f0-9]{8}$/),
  prefix: z.string(),
  email: z.email(),
  password: z.string().min(16),
  totpSecret: z.string().min(16),
  backupCodes: z.array(z.string()),
  plain: z.email(),
  projects: z.object({
    alpha: projectSchema,
    beta: projectSchema,
    hidden: projectSchema,
    gamma: projectSchema,
  }),
  sso: z.object({
    oidc: z.email(),
    saml: z.email(),
    stranger: z.email(),
    newcomer: z.email(),
  }),
});
export type Desk = z.infer<typeof deskSchema> & { idpPassword: string };
// The database is private to the Compose network, so fixture data is created
// inside the app container. Its output carries a generated password and is
// never logged.
// Against a deployed instance the fixture runs on this machine with the environment of that
// instance (`E2E_FIXTURE_ENV_FILE`): it writes into the same database and storage that the
// deployment reads. The deployment itself keeps its production settings.
export const remote = Boolean(process.env.E2E_FIXTURE_ENV_FILE);
export function fixture(...args: string[]): string {
  const output = remote
    ? execFileSync(
        "bash",
        [
          "-c",
          'set -a; . "$E2E_FIXTURE_ENV_FILE"; set +a; DEV_BOOTSTRAP=true NODE_ENV=development exec pnpm exec tsx scripts/e2e-fixture.ts "$@"',
          "fixture",
          ...args,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      )
    : execFileSync(
        "sh",
        [
          "scripts/dev.sh",
          "exec",
          "-T",
          "app",
          "pnpm",
          "exec",
          "tsx",
          "scripts/e2e-fixture.ts",
          ...args,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
  const line = output.trim().split("\n").at(-1);
  if (!line) throw new Error("The fixture script returned no result.");
  return line;
}
// A production build shows the sign-in with a password behind a button; the development stack
// shows it at once.
export async function openPasswordSignIn(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Owner sign-in with password" });
  await expect(toggle.or(page.getByLabel("Password"))).toBeVisible();
  if (await toggle.isVisible()) await toggle.click();
}
// Opens a topic of the settings, in the project that is named when the topic belongs to a project. The topics are links
// in the list on the left; the project is chosen in the list of the group Project.
// The topics of the account are behind the entry of the person at the bottom of the menu; the others are the settings of
// the workspace and of the projects, behind the entry "Settings".
const accountTopics = ["Profile", "Notifications", "Sign-in and security"];
export async function openAccount(page: Page): Promise<void> {
  // On a narrow screen the entry is in the panel of the last tab.
  const more = page.getByRole("navigation").getByRole("button", { name: "More" });
  if ((await more.isVisible()) && (await more.getAttribute("aria-expanded")) !== "true")
    await more.click();
  await page.getByRole("button", { name: /^Account of / }).click();
}
export async function openSettings(page: Page, topic: string, project?: string): Promise<void> {
  const account = accountTopics.includes(topic);
  const area = page.locator("section.settings");
  // The area that is shown has to be the one of the topic: the account is not a part of the settings.
  if (
    !(await area.isVisible()) ||
    (await area.getAttribute("aria-label")) !== (account ? "Account" : "Settings")
  ) {
    if (account) await openAccount(page);
    else await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
    await expect(area).toBeVisible();
  }
  const list = page.getByRole("complementary", { name: "Topics" });
  if (!(await list.isVisible())) {
    // On a narrow screen an open topic hides the list; its back button shows it again.
    await page.locator(".settings-back").click();
    await expect(list).toBeVisible();
  }
  if (project) {
    // The group of the project appears with the answer about the rights of the person.
    await expect(list.getByRole("heading", { name: "Project", exact: true })).toBeVisible();
    const choice = list.getByRole("combobox", { name: "Project" });
    if ((await choice.count()) > 0) await choice.selectOption({ label: project });
  }
  await list.getByRole("link", { name: topic, exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: topic, exact: true })).toBeVisible();
}
// The pages are rendered on the server and take their handlers only when the scripts have run, which in a development
// build can be seconds after the load event. A click or a selection before that is lost without a trace: the control
// takes the focus and nothing happens. In CI the traces of a test that waited a minute for a view showed the overview
// with the focused menu button. React marks each control it has taken over, so a page counts as ready when every
// control carries that mark once the document is parsed. A page that does not get there in time is used as it is.
export async function hydrated(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        document.readyState !== "loading" &&
        [...document.querySelectorAll("button, select, input, textarea, summary")]
          .filter((control) => !control.closest("nextjs-portal"))
          .every((control) => Object.keys(control).some((key) => key.startsWith("__reactProps$"))),
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
}
export const mailpit = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";
export const test = base.extend<{ signIn: () => Promise<void> }, { desk: Desk }>({
  // Each navigation of the page waits until the page has taken its handlers.
  page: async ({ page }, use) => {
    const goto = page.goto.bind(page);
    const reload = page.reload.bind(page);
    page.goto = async (url, options) => {
      const response = await goto(url, options);
      await hydrated(page);
      return response;
    };
    page.reload = async (options) => {
      const response = await reload(options);
      await hydrated(page);
      return response;
    };
    await use(page);
  },
  desk: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
    async ({}, use) => {
      const desk = { ...deskSchema.parse(JSON.parse(fixture("setup"))), idpPassword: "" };
      // The identity provider of the development stack is not reachable from a deployment.
      const idpUsers = remote
        ? []
        : [desk.sso.oidc, desk.sso.saml, desk.sso.stranger, desk.sso.newcomer];
      try {
        desk.idpPassword = randomBytes(16).toString("hex");
        for (const email of idpUsers) await createIdpUser(email, desk.idpPassword);
        await use(desk);
      } finally {
        for (const email of idpUsers) await deleteIdpUser(email);
        fixture("teardown", desk.run);
      }
    },
    { scope: "worker" },
  ],
  signIn: async ({ page, desk, baseURL }, use) => {
    await use(async () => {
      const headers = { origin: baseURL ?? "" };
      // A production build limits sign-ins and codes to a few every ten seconds for each address,
      // which a run of many tests exceeds; a refused call is made again when the window has passed.
      const post = async (path: string, data: object) => {
        for (let attempt = 0; ; attempt += 1) {
          const answer = await page.request.post(path, { data, headers });
          if (answer.status() !== 429 || attempt >= 8) return answer;
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      };
      const response = await post("/api/auth/sign-in/email", {
        email: desk.email,
        password: desk.password,
      });
      expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
      const verified = await post("/api/auth/two-factor/verify-totp", {
        code: totp(desk.totpSecret),
      });
      expect(verified.ok()).toBe(true);
    });
  },
});
export { expect };
