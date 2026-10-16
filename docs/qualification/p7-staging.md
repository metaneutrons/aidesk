# Qualification against a deployed instance (Vercel)

Evidence for P7-A1 and P7-A3 of [the completion plan](../plans/m4-completion.md). The instance was
deployed on 2026-10-16 as a project on the Hobby plan of Vercel, with a hosted PostgreSQL of Supabase and
an R2 bucket of Cloudflare, and the browser suite and a remote MCP client were run against it. The
addresses, keys and secrets are not part of this file.

## What was deployed

- The application of `main` (revision `b4d431a`, plus the pull request about the settings of the
  connection pool, `b7a24a1`), built by Vercel as it is (`pnpm build`, the standalone output is not
  used by the platform) and run as functions on Node 24.
- Variables of the deployment: `APP_URL`, `DATABASE_URL`, `DATABASE_POOL_MAX=5`, `DATABASE_PREPARE=false`,
  `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `S3_*`, `OWNER_CLAIM_TOKEN`, `CRON_SECRET`. The database is the
  pooler of Supabase in transaction mode with a role of its own (it may create schemas and objects in the `public` schema, nothing else is granted); the bucket has
  a token of its own that reaches this bucket only.
- `vercel.json` of the repository with the daily call of `/api/worker/tick`; for the staging copy a
  function region next to the database (`dub1`).

## Runs

- **P7-A1, a remote MCP client over HTTPS.** `tests/e2e/mcp.spec.ts` with `E2E_MCP_URL` connects with the
  SDK client to `/api/mcp` of the deployment, with the certificate checked against the roots of the system,
  with a project-scoped token. It lists the tools that the grants allow, reads and changes a ticket
  within them, is refused outside them, and the token stops working after its revocation. Passes.
- **P7-A3, the browser suite.** `pnpm exec playwright test --project=chromium` with
  `E2E_FIXTURE_ENV_FILE` (the environment of the deployment), `E2E_BASE_URL` and `E2E_MCP_URL`: **52 passed,
  10 skipped, 0 failed** (62 tests; two workers; about 1.6 minutes). The fixture writes into the
  database and the storage that the deployment reads, from the machine of the person who runs it
  (`scripts/e2e-fixture.ts` refuses to run unless the development flags are set, and the deployment keeps its
  production settings). The suite was run five times; the first four runs found the differences below.
- Only Chromium was run against the deployment. Firefox and WebKit run in CI against the Docker stack.

## What does not run against a deployment, and why

| Left out                                                                                           | Reason                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `inbound.spec.ts` (4 tests), `designs.spec.ts` (3), `webhooks.spec.ts` (1)                         | They need the mailboxes and the receiver of the development stack, or a delivery by the worker.                                    |
| `sso.spec.ts` (5), the SSO test and the test of disabling an operator in `settings.spec.ts`        | They need the identity provider of the development stack; the second works on the operator that the first creates.                 |
| Test of a connection in `connections.spec.ts`, `issues.spec.ts`                                    | Their servers are addresses inside the development stack; a deployment refuses development addresses by design.                    |
| Two reply tests of `desk.spec.ts`, the link in a reply in `portal.spec.ts`, `translations.spec.ts` | They wait for a mail or a job, and a deployment takes both only when the schedule calls the worker (once a day on the Hobby plan). |
| Two tests of the sign-in form before and after hydration                                           | A production build has no password field in the page until a button is pressed, so there is nothing to disable or enable.          |

The contract spec uses a public HTTPS address for its webhook instead of `localhost`. The sign-in tests use the
button "Owner sign-in with password" first.

## Differences between the platform and the Docker stack

1. **Node.** Vercel supports Node 24 at most; the repository asks for `>=26 <27` in `engines`, which Vercel
   refuses ("invalid or discontinued Node.js Version"). The staging copy sets `engines.node` to `24.x` and
   nothing else. The 52 tests passed on Node 24; the repository is still tested only on Node 26 in CI.
2. **Database connections.** Ten connections for each instance exhaust the pooler of Supabase in session mode
   (a pool of 15, `EMAXCONNSESSION`) after a few instances. The transaction mode needs
   `DATABASE_PREPARE=false`. A pool of **one** connection blocks: code that queries `db()` inside a
   transaction waits for the connection that its own transaction holds, until the function times out
   after 300 seconds. Five connections for each instance worked. The code that queries inside a transaction
   is a defect for any small pool and is not fixed here.
3. **Rate limit of the sign-in.** A production build allows a few sign-ins and codes every ten seconds for
   an address and answers 429 after that. A run of many tests exceeds it; the test helper waits and tries
   again. This is the behaviour that protects the sign-in, not a defect.
4. **The password form** is behind a button in production (see above).
5. **The worker** runs on the schedule only. With a daily call, mail is polled and jobs are taken once a day, and
   `/api/worker/tick` can be called by any scheduler that sends the secret. The reading of PDF and Office
   files does not exist in a function bundle (see the worker pass).
6. **The production build** failed once with esbuild in the bundle of the function route; `esbuild` is a server-external
   package since the worker pass.
7. **Latency.** A request to the readiness route, which checks the database and the storage, takes about 0.4 to
   1.1 seconds from this machine. A static answer takes 0.1 second.
8. **Protection of the deployment.** The default of the platform protects previews with the login of the
   platform and leaves the address of the production deployment open, so a remote client reaches it.
9. **A project that is linked from a checkout** is connected to the Git repository by the CLI and then builds every
   pull request and comments on it; the connection was removed for this project (`vercel git disconnect`).

## What this does not show

- Mail in and out, SSO, the worker in the background and the daily schedule were not exercised on the
  deployment. They are covered by the Docker stack and, for mail, by the live round trip of 2026-10-12.
- One run per test; the suite is quick and the results are a sample.
- Firefox and WebKit, a custom domain, and the Pro-plan schedule with shorter intervals.
- Recovery on the platform (backup and restore of the hosted database) was not tried.

## Repeat

```bash
# the environment of the deployment (not in the repository), the address, and the MCP endpoint
E2E_FIXTURE_ENV_FILE=./staging.env \
E2E_BASE_URL=https://<project>.vercel.app \
E2E_MCP_URL=https://<project>.vercel.app/api/mcp \
pnpm exec playwright test --project=chromium --workers=2
```
