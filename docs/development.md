# Development handoff

Current slice: Docker development foundation. Execution and qualification remain
owned by [M1 #2](https://github.com/metaneutrons/aidesk/issues/2) and
[M5 #6](https://github.com/metaneutrons/aidesk/issues/6); the product authority is
the [initial plan](plans/initial-product.md). This slice does not close a milestone.
The [local implementation handoff](handoff-local.md) supplies checkout/start
commands, migration boundaries and the next agent's continuation prompt.

## Data and configuration

PostgreSQL holds projects, explicit project/action memberships, tickets, Markdown
messages, connection definitions, durable jobs, audit, identities and sessions.
Private S3 storage is prepared for original mail and attachments. The local
SeaweedFS service supplies the same S3 boundary; blobs are not stored in the
Next.js runtime filesystem. Production storage/encryption/authentication root
settings are deployment variables listed in `.env.example`.

Project creation and UI locale preferences persist through the application API.
Inbound/outbound connection records are independent. The development bootstrap
assigns a Mailpit SMTP connection explicitly to each example project. Production
connection management, provider setup and full project email design remain open.
SSO provider configuration is encrypted through the server database adapter.
Service tokens are hashed; sessions follow Better Auth's persisted session model.

Next.js 16.4 / React 19.3, Tailwind 4.3 / Base UI, Drizzle / PostgreSQL 18,
Better Auth 1.7 with OIDC/SAML plugin, next-intl, React Email rendering, Zod and
the MCP SDK form the foundation. Native build/install scripts remain enabled.
TypeScript stays on `~6.0` because the gitrepo standard and typed ESLint peer
range require it. Next's web project overrides the base module settings with
ES modules/bundler resolution; the strict base flags remain enabled.
Framework ambient types are explicit so a clean checkout can typecheck before
Next generates `next-env.d.ts`. That generated file stays ignored: switching
between development and production output folders must not dirty the checkout.

The pnpm override of the legacy Drizzle loader's esbuild dependency addresses
GHSA-67mh-4wv8-2f99. It is an explicit compatibility boundary: frozen installation,
Drizzle generation, auth, tests and framework build must remain qualified when
the override or parent package changes. No advisory is suppressed.

## What the slice supports

Staff can log in with the generated development credentials, see only explicitly
granted projects, filter a shared inbox, read a Markdown conversation, preserve
a per-ticket browser draft, record a private note and queue a same-language
public reply. The worker rechecks current permissions, configuration, revision
and outgoing pause before SMTP dispatch. The earliest unanswered clock completes
only after transport acceptance. Ambiguous/expired dispatches require review;
this initial worker does not automatically retry an uncertain send.

REST begins at `/api/v1`, MCP at `/api/mcp`. The stateless Streamable HTTP MCP
endpoint requires an active, unexpired project-scoped bearer agent token. Token
provisioning UI and owner recovery are not finished. MCP registration is filtered
by permissions, and the shared operations check each requested resource again.
The [capability ledger](capabilities.md) records current interface differences.

## Reproduce the local check

Start the stack with the README command. Run its quality commands inside
the app container. Check readiness at `/api/health/ready`, sign in, open an example
ticket, save a note and send a reply. Inspect Mailpit's HTML and text views and
check that the note is absent from mail. Stop and restart the stack; the project,
message and connection records must remain. Never use `down -v` to stop normally.

Playwright browser tests run on the host against the running stack. Install the
browsers once with `pnpm exec playwright install chromium firefox webkit`, then
run `pnpm test:e2e`. Each Playwright worker creates its own operator and projects
under an `e2e-` prefix inside the app container (`scripts/e2e-fixture.ts`) and
deletes them afterwards, so the development desk data stays unchanged. CI runs
them in the Browser tests job against the same Compose stack.
`tests/e2e/accessibility.spec.ts` runs the axe-core WCAG 2.2 A/AA rules on the
sign-in page, overview, an open ticket with composer and the project dialog in
light and dark appearance. Automated rules detect only part of the barriers;
manual keyboard, screen-reader and zoom checks are still required before any WCAG
claim. Base UI's dialog focus guards are excluded because Base UI gives them
role="button" in WebKit on purpose for VoiceOver.

The 90% coverage floor applies to all current domain/server TypeScript, including
database schema code. Tests use real PostgreSQL for scopes, grants, sessions,
revocation, encrypted SSO configuration, audit, revision and idempotency behavior;
storage error tests deliberately simulate 404/403/service failures. Those cases
do not qualify a real SSO provider or external mail provider.
The process/SMTP orchestration in `src/worker` is outside this coverage set and
is exercised through Mailpit and container restart checks. Full negative
dispatch/lease/race qualification remains M2/M5 work; the coverage figure must
not be presented as that worker's branch coverage.

The cloud run verified SMTP acceptance in Mailpit and production framework
builds. A temporary GitHub/npm proxy outage was followed by a successful fresh
Compose build/start. Browser installation still returned a destination-policy
403; browser evidence remains open. Exact source/run evidence belongs in the
linked milestone issues before acceptance.

## Remaining product work

Real OIDC/SAML provider qualification, provisioning/recovery/MFA, complete
configuration UI/API/MCP, inbound mail and threading, Cloudflare and IMAP, portal
grants, junk/extraction pipeline, original HTML preview, per-project template
editing, translation jobs, named AI assignment/runners, knowledge/GitHub,
escalations, pagination/complete dashboard aggregates and operational health are
still milestone work. The present list loads at most 250 conversations; it does
not qualify the planned production scale. Messenger adapters are reserved in
the plan and are not presented as working connections.

Vercel HTTPS, a hardened production Docker target, real remote MCP, browser and
usability/accessibility runs, repository-settings audit, backup/restore,
retention/export/deletion and measured recovery targets also remain open.
Do not equate a passing development build with these qualifications.
