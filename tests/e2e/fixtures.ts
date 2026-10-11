import { execFileSync } from "node:child_process";
import { test as base, expect } from "@playwright/test";
import { z } from "zod";
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
  projects: z.object({ alpha: projectSchema, beta: projectSchema, hidden: projectSchema }),
});
export type Desk = z.infer<typeof deskSchema>;
// The database is private to the Compose network, so fixture data is created
// inside the app container. Its output carries a generated password and is
// never logged.
function fixture(...args: string[]): string {
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
      const desk = deskSchema.parse(JSON.parse(fixture("setup")));
      try {
        await use(desk);
      } finally {
        fixture("teardown", desk.run);
      }
    },
    { scope: "worker" },
  ],
  signIn: async ({ page, desk, baseURL }, use) => {
    await use(async () => {
      const response = await page.request.post("/api/auth/sign-in/email", {
        data: { email: desk.email, password: desk.password },
        headers: { origin: baseURL ?? "" },
      });
      expect(response.ok()).toBe(true);
    });
  },
});
export { expect };
