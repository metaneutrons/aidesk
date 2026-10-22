import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test as base, expect, type Locator, type Page } from "@playwright/test";
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
  sso: z.object({ oidc: z.email(), saml: z.email(), stranger: z.email() }),
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
// Opens a collapsed section of the settings. The sections are filled in while the page is still loading, and in CI a
// click on the heading that lands in between was lost now and then (no request for the content was ever sent), so
// the section is checked and clicked again until it stays open.
export async function openSection(section: Locator, heading: string | RegExp): Promise<void> {
  const details = section.locator("details").first();
  await expect(async () => {
    if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
      await section.getByRole("heading", { name: heading }).click({ timeout: 5_000 });
    await expect(details).toHaveJSProperty("open", true, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
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
      const idpUsers = remote ? [] : [desk.sso.oidc, desk.sso.saml, desk.sso.stranger];
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
