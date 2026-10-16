import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test as base, expect } from "@playwright/test";
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
export function fixture(...args: string[]): string {
  const output = execFileSync(
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
export const mailpit = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";
export const test = base.extend<{ signIn: () => Promise<void> }, { desk: Desk }>({
  desk: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
    async ({}, use) => {
      const desk = { ...deskSchema.parse(JSON.parse(fixture("setup"))), idpPassword: "" };
      const idpUsers = [desk.sso.oidc, desk.sso.saml, desk.sso.stranger];
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
      const response = await page.request.post("/api/auth/sign-in/email", {
        data: { email: desk.email, password: desk.password },
        headers,
      });
      expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
      const verified = await page.request.post("/api/auth/two-factor/verify-totp", {
        data: { code: totp(desk.totpSecret) },
        headers,
      });
      expect(verified.ok()).toBe(true);
    });
  },
});
export { expect };
