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
Private S3 storage is prepared for original mail and attachments. In Docker it is
PGSTY Silo (`pgsty/silo`, an AGPL-3.0 MinIO fork run as a separate service and
used only through the S3 API); blobs are not stored in the Next.js runtime
filesystem. The development stack uses Silo's root credentials as the
application's S3 key pair; a production deployment needs a scoped key and policy.
Production storage/encryption/authentication root settings are deployment
variables listed in `.env.example`.

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

## Single sign-on

Operators sign in through SSO providers registered by an owner. Better Auth's SSO
plugin handles OIDC (authorization code with PKCE and a database-backed,
single-use state; no OIDC nonce) and SAML (signed assertions required, issuer,
audience, destination, InResponseTo and time checks, and a one-time assertion ID
cache against replay). Provider configuration, including client secrets, is stored
encrypted (`encryptedText` columns); OAuth tokens are encrypted as well, and the
development OIDC provider requests no `offline_access`.

SSO never creates aidesk users. The plugin's `disableImplicitSignUp` can be
overridden by an unauthenticated `requestSignUp` flag for OIDC; the auth route
therefore refuses any `/sign-in/sso` request carrying that flag. An IdP account
reaches aidesk only when an operator with the same, verified email exists; the
plugin links the account when the provider's domain is verified and the email
domain matches. Project access still comes only from explicit grants, and a
disabled operator or a revoked session loses access immediately.

Provider domains are verified through DNS TXT records in production. The
development bootstrap (`scripts/dev-sso.ts`) registers the local Keycloak realm as
`keycloak-oidc` and `keycloak-saml` through the plugin API as the development
owner, marks the reserved `.test` domains verified, and provisions the two test
operators. Better Auth fetches only from public hosts unless an origin is trusted;
the development stack trusts the Keycloak origins through
`BETTER_AUTH_TRUSTED_ORIGINS`. Keycloak's realm descriptor always requests signed
AuthnRequests, so the SAML provider is registered with the IdP entity ID and
signing certificate instead of the metadata XML.

Browser tests in `tests/e2e/sso.spec.ts` create per-run IdP accounts through the
Keycloak admin API from the host and cover OIDC and SAML sign-in, a replayed OIDC
callback and SAML response, refusal of an unprovisioned IdP user, the sign-up
flag, revoked sessions and disabled operators. Production IdPs, owner recovery
with MFA and SSO on a Vercel deployment are not qualified yet.

## Owner setup and recovery

Owners are the only operators with a local credential, a password plus TOTP. It is
their way in when the identity provider is unavailable; everyone else signs in
through SSO. Password sign-in is refused for anyone who is not an active owner
with TOTP, with the same response as a wrong password. The generated development
owner is the one exception, so the private stack works without an authenticator.

The first owner is claimed once at `/setup` with the deployment secret
`OWNER_CLAIM_TOKEN`. Step one checks the token and prepares TOTP: the secret and
ten backup codes are shown once and kept encrypted for ten minutes as a pending
claim. Step two creates the owner only with a valid TOTP code, so an owner never
exists without a second factor. An advisory lock serialises concurrent claims;
once an owner exists, the setup endpoints refuse every request. The claim and
every recovery sign-in (TOTP or backup code) are written to the audit log. Remove
`OWNER_CLAIM_TOKEN` after the claim.

TOTP comes from Better Auth's two-factor plugin. aidesk refuses `trustDevice`,
which would skip TOTP for 30 days, and blocks enabling or disabling TOTP over the
API. Backup codes work once. Known limitation: the plugin does not remember used
TOTP codes, so a code can be reused within its 90-second window by someone who
also knows the password. Further owners, re-enrolment after a lost authenticator
and owner management are not implemented yet.

## Remote MCP over HTTPS

The development stack serves the app through Caddy at `https://localhost:8443`
with certificates from Caddy's local CA. Clients verify them against its root
certificate; `sh scripts/dev.sh https-ca` prints it. The MCP endpoint is
`/api/mcp` (stateless Streamable HTTP) and needs a project-scoped bearer token.

People with `agent.manage` on a project issue tokens through `POST
/api/v1/projects/:id/agents` (`name`, `actions`, `expiresInDays` up to 90) and
revoke them with `POST /api/v1/agents/:id/revoke`. A token never gets an action
its issuer lacks or `agent.manage`, agents cannot issue tokens, the value is
returned once and only its SHA-256 hash is stored, and issue and revoke are
audited. A settings UI for tokens is M3 work.

Claude Code was qualified as a real remote client: with a token for one project it
saw only that project and its tickets; without the root certificate and after
revocation it had no aidesk tools. To repeat it, export the certificate and add
the server with the token in a header:

```sh
sh scripts/dev.sh https-ca > .local/https-ca.crt
NODE_EXTRA_CA_CERTS=.local/https-ca.crt claude mcp add --transport http aidesk https://localhost:8443/api/mcp --header "Authorization: Bearer <token>"
```

Interactive OAuth discovery with PKCE and resource binding for MCP clients is not
implemented; clients use issued bearer tokens.

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
