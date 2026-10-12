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

## Operator administration

The Settings view lists operators. Owners add operators by name and email and
disable or re-enable them; owners themselves and the caller cannot be disabled
there, and disabling ends the operator's sessions. An added operator signs in
through SSO with that email: the identity provider account is linked when the
provider's domain is verified and the email domain matches.

Project access is set per project with the roles No access, Read, Respond and
Manage, or kept as Custom. Only people who manage a project change its access, and
never beyond the actions they hold there; owner status alone gives no project
access. Changes are audited. The same view issues and revokes service tokens for
projects where the caller has `agent.manage`. REST offers the same operations
(`/api/v1/operators`); MCP does not, as recorded in the capability ledger.

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

## Inbound mail

Adapters hand raw messages to `acceptInbound`. The original is stored first in
private object storage under its SHA-256 checksum; then the ingress record and its
`mail.ingest` job are committed together. A repeated external key (for example the
same IMAP UID) is recognised as a duplicate before any processing.

The worker parses the message and decides per project under a lock. A Message-ID
already seen in the project is a duplicate. A reply continues a ticket only when
it references one of that ticket's messages in this project and comes from the
ticket's requester; claimed identifiers alone or another sender start a separate
ticket, so no history leaks. Replies reopen Waiting tickets and tickets resolved
within 30 days; later replies start a follow-up linked to the old ticket. The
response obligation starts at the trusted receipt time of the first unanswered
message.

Content extraction works without AI: it removes quoted history after an
attribution line, Outlook headers and signatures only at the end of the message
and keeps inline replies between quotes. HTML is converted to Markdown; Gmail
and Outlook signature blocks and the escaped `-- ` delimiter are recognised. The
message records whether anything was removed and whether unquoted text was
removed on a heuristic (a forwarded-style header block, a separator line or a
signature longer than eight lines). Such uncertain trims are marked in the
conversation, and readers of the ticket can download the private original
(`GET /api/v1/messages/:id/original`, always as a download).
Processing is idempotent; lost leases are requeued and transient failures retry
with backoff (at most six attempts in about a day), permanent ones go to review.

The IMAP adapter polls every inbound IMAP connection (every five seconds in the
development stack, otherwise every minute). Its cursor stores mailbox, UIDVALIDITY
and the last UID and advances only after each message is durably accepted; a
changed UIDVALIDITY rereads the mailbox and the core drops the duplicates. TLS is
required except for connections marked development-only, a stored password is
required, and failures mark the connection Degraded until a poll succeeds.

The development stack includes GreenMail (SMTP on `127.0.0.1:3025`, IMAP on
`127.0.0.1:3143`, any password, mailboxes created on delivery). The bootstrap
connects Orbit and Harbor to the mailboxes `orbit@support.local` and
`harbor@support.local`, so mail sent there through GreenMail's SMTP port becomes
tickets. `scripts/dev-inbound.ts` still feeds a raw message directly:

```sh
sh scripts/dev.sh exec -T app pnpm exec tsx scripts/dev-inbound.ts orbit < mail.eml
```

Attachments are stored as private objects under
`attachments/<project>/<sha256>` before the message is committed; their
metadata (name, type, size, position, inline flag and Content-ID) is a separate
table. Names lose paths and control characters. Executable types and disk
images (by extension or declared type), files over 15 MB and files beyond the
25th are not stored; the message is kept and the file is listed with the
reason. `GET /api/v1/attachments/:id` needs `ticket.read` on the project and
always answers as a download (`application/octet-stream`, `nosniff`,
`Content-Security-Policy: sandbox`, `no-store`); refused files, other projects
and unknown ids all answer 404. Ticket responses list the metadata on every
surface; MCP does not yet return file content.

A project can send acknowledgements (Settings, Projects; requires
`project.manage`; off by default). For each new ticket the inbound core then
adds a system message with the ticket number in the ticket language and queues
it through the project's outgoing connection in the same transaction. It is not
sent to automatic mail (`Auto-Submitted` other than `no`, `Precedence`
bulk/list/junk, list headers, `X-Auto-Response-Suppress` with All/AutoReply/OOF,
an empty return path, or senders such as `mailer-daemon` and `noreply`), not
for replies in an existing ticket, and at most once an hour per sender and
project. The mail carries `Auto-Submitted: auto-replied` and
`X-Auto-Response-Suppress: All`. An acknowledgement is not an answer: the ticket
stays open and its response obligation is unchanged. The worker sends it only
while the project still has acknowledgements enabled.

Junk has its own view. Inbound mail that an upstream spam filter marked
(`X-Spam-Flag: YES`, `X-Spam-Status: Yes`, `X-Spam: yes`) is classified before
threading: it creates no ticket, is not added to an existing ticket (even one it
references), and gets no acknowledgement. Operators with `ticket.junk` (part of
the Respond and Manage roles; migration 0005 adds it to existing grants with
`ticket.reply`) can also move a ticket to junk. A ticket in junk keeps its
status and history, leaves the inbox and the ticket list of every surface,
accepts private notes but no public reply, and the worker sends nothing queued
for it. "Not junk" restores a ticket as it was; a junk mail returns to inbound
processing without classification and then threads like any arrival. The
preview of a junk mail is sanitized; the original stays private. The AI
classifier follows with M4.

For mail read over IMAP, the original follows the decision: a junk mail is
moved to the connection's `junkMailbox` (or the server's `\Junk` folder) and
back to the polled mailbox when restored. The move runs as an idempotent
`mail.junk_sync` job without a fixed direction, so a late or repeated run
cannot undo a newer decision; a missing junk folder is retried with backoff
and shown in the junk view. A run interrupted after the IMAP move finds the
message by its Message-ID. A message moved back gets a new UID; its external
key is recorded as an alias, and a byte-identical copy of a restored mail is
treated as a duplicate, so the next poll neither reads it again nor classifies
it as junk once more.

A delivery status notification (RFC 3464, `multipart/report` with
`report-type=delivery-status`) for a sent reply belongs to that reply and creates
no ticket. It must name the Message-ID of one of the project's sent messages and
the requester's address as the final recipient; anything else is processed like
other mail. For `Action: failed` the reply moves to review with the reason
"bounced" (status code and diagnostic stay in the message source), and the
ticket is open again with its response obligation, even if the reply had
resolved it. For an acknowledgement, or a ticket in junk, only the message is
marked. A delay notice and a repeated report change nothing. SMTP2GO collects
bounces itself under its own return path and does not forward them, so this path
applies to transports whose return path reaches the project mailbox; a provider
webhook is not implemented.

Not yet implemented: language detection. GreenMail is a
real IMAP server but not a provider mailbox; real provider qualification is still
open.

## Cloudflare mail

Inbound, Cloudflare Email Routing hands each message for a routed address to
the Email Worker in `cloudflare/mail-ingest`. The worker stores the message
unchanged in an R2 bucket under `inbound/<recipient>/<receipt time>-<random>.eml`
and does nothing else. aidesk collects these objects through the S3 API at the
same interval as IMAP, accepts each one through `acceptInbound` and deletes it
only afterwards. While aidesk is unreachable, mail waits in the bucket. A crash
between acceptance and deletion leaves the object in place; the next poll
recognises its external key and only deletes it. The endpoint must use HTTPS
unless the connection is marked development-only.

Outbound, a Cloudflare connection sends replies through the Email Sending REST
API with In-Reply-To and References. Cloudflare assigns the Message-ID itself;
aidesk stores the returned value for later threading. A refusal before
acceptance is recorded as `transport_rejected`; timeouts, server errors and
responses that do not list the recipient as delivered or queued leave the
outcome unknown. Both go to review and are never resent automatically. SMTP
sends follow the same rule: a failure reply from the server, a failed
connection or a failed login before the DATA command counts as
`transport_rejected`; a timeout or a dropped connection once DATA was sent
leaves the outcome unknown. The mailer labels every lost connection alike, so
the worker follows the command log to tell the two apart.
The worker logs the SMTP command, reply code and enhanced status code, but not
the reply text or any address.

SMTP2GO accepts mail for a suppressed recipient (for example after an
unsubscribe through its `List-Unsubscribe` header) with 250 and drops it later.
An SMTP connection with `suppressionCheck: "smtp2go"` and an API key in its
secret therefore checks the recipient against the SMTP2GO suppression list
before each send. A listed recipient stops the send as `recipient_suppressed`;
if the list cannot be read, the send stops as `suppression_check_failed`. Both
go to review without contacting the SMTP server.

Without the Workers Paid plan and an onboarded sending domain, Cloudflare only
delivers to verified destination addresses of the account. Each routing rule
names one address and one worker.

Setup for one address (bucket `aidesk-mail` in the EU jurisdiction):

1. Create the bucket with the header `cf-r2-jurisdiction: eu`.
2. Deploy the worker:
   `pnpm dlx wrangler@4.143.0 deploy --config cloudflare/mail-ingest/wrangler.jsonc`.
3. Add an Email Routing rule that sends the address to the worker
   `aidesk-mail-ingest`.
4. Create an R2 token limited to this bucket (object read and write) and a
   token with Email Sending Write. R2 derives the S3 key pair from the token:
   the access key ID is the token ID, the secret is the SHA-256 hex digest of
   the token value.
5. Connect a project; the script creates it if the slug is new and updates
   existing connections in place. `--outbound smtp` sends through an SMTP
   submission server instead (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
   `SMTP_PASSWORD`; port 465 uses implicit TLS, other ports require STARTTLS).
   With `SMTP2GO_API_KEY` set, the connection also checks the SMTP2GO
   suppression list before each send:

```sh
sh scripts/dev.sh exec -T -e CLOUDFLARE_ACCOUNT_ID -e CLOUDFLARE_R2_ACCESS_KEY_ID \
  -e CLOUDFLARE_R2_SECRET_ACCESS_KEY -e CLOUDFLARE_SENDING_TOKEN app \
  pnpm exec tsx scripts/cloudflare-mail.ts --project <slug> --name <name> \
  --address <address> --grant <operator email>
```

## What the slice supports

Staff can log in with the generated development credentials, see only explicitly
granted projects, filter a shared inbox, read a Markdown conversation, preserve
a per-ticket browser draft, record a private note and queue a same-language
public reply. The worker rechecks current permissions, configuration, revision
and outgoing pause before SMTP dispatch; a refusal at that point keeps its
reason (changed ticket revision, paused or changed connection, revoked
permission, disabled acknowledgements, connection not ready) in the review. The
earliest unanswered clock completes only after transport acceptance.
Ambiguous/expired dispatches require review; this initial worker does not
automatically retry an uncertain send. A worker that lost its lease writes
neither success nor failure; when that lease ends too, the dispatch goes to
review instead of being sent again.

When a message is accepted by the transport, the worker keeps a snapshot of it in
the message: time, transport, recipient, sender and reply-to address, subject,
language, template version, the final Markdown and the rendered HTML and text.
Later changes of the ticket, the message or the template do not alter it. The
ticket view shows the facts of the snapshot (`sent`), `getSentSnapshot` returns
the whole mail to readers of the project, and only for sent public messages. The
draft in the author's own language is not kept separately yet; translation of
drafts follows with M4.

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
