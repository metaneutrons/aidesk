import { defineConfig, devices } from "@playwright/test";
// Runs against the private development stack (sh scripts/dev.sh up -d). Each
// worker creates isolated data through scripts/e2e-fixture.ts.
// With E2E_FIXTURE_ENV_FILE it runs against a deployed instance (see docs/qualification/p7-staging.md);
// the specs that need the services of the development stack (mailboxes, the identity provider and
// the worker, which a deployment runs only when its schedule calls it) are left out.
const deployed = Boolean(process.env.E2E_FIXTURE_ENV_FILE);
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/warm-up.ts",
  testIgnore: deployed
    ? ["inbound.spec.ts", "sso.spec.ts", "designs.spec.ts", "webhooks.spec.ts"]
    : [],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  // An assertion that waits for the page to answer gets five seconds on a machine of its own and fifteen in
  // CI, where three browsers share two cores with the development server and a click that is answered
  // after six seconds is slow, not broken. An assertion that succeeds fast is not slowed by this.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    locale: "en-US",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: devices["Desktop Chrome"] },
    { name: "firefox", use: devices["Desktop Firefox"] },
    { name: "webkit", use: devices["Desktop Safari"] },
  ],
});
