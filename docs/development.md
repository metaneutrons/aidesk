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

"Preview original" in a message opens the original as a safe view
(`GET /api/v1/messages/:id/original/preview`, same rights as the download).
The sender controls the markup, so it is reduced to formatting tags, tables and a
few style properties (colors, weight, alignment, size); scripts, forms, frames,
styles, event handlers and `javascript:` addresses are removed, and links keep
`http`, `https` and `mailto`. Remote images are not loaded (the dialog says how
many were left out); only images that the mail itself carries by `cid:` are
shown, as `png`, `jpeg`, `gif` or `webp` of at most 2 MB each and 6 MB in total,
so an SVG attachment is never embedded. The view is a frame without scripts
(`sandbox`) whose own policy admits nothing but data images, and a plain-text view
is the fallback. The dialog closes with Escape and returns focus to its button.

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

A project can send acknowledgements (Settings, Configuration; requires
`config.write`; off by default). For each new ticket the inbound core then
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

A new ticket takes the language of its first message when it can be named
reliably, otherwise the project's default language. The detection
(`src/domain/language.ts`) counts function words that belong to only one of the
supported languages (English, German) in what the person wrote, without quoted
history, code and links. It needs at least eight words, three function words
of one language and clearly more than of the other; a short, mixed or neutral
text yields no language instead of a guess. Each message records the detection
and the first message the decision (`ticket`, `requester`, `detected` or
`project`, and whether the project default was used because detection was
open). The order is explicit ticket choice, requester preference, detection,
project default; the operator's interface language is no input. A later message
in another language keeps the ticket language and records its own. Requester
preferences and enabled target languages per project follow with the portal and
translation work.

Not yet implemented: translation. GreenMail is a
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

## Customer portal

A person with `ticket.reply` creates a portal link for the requester of a ticket
(button "Create portal link" in the ticket header, `POST /api/v1/tickets/:id/portal-link`).
The link is `<APP_URL>/portal/<token>` and is shown once; "Disable portal link"
ends the access. A link is not stored: it is the participant's identifier plus a
MAC over that identifier and the participant's epoch, made with a key derived
from `ENCRYPTION_KEY`. A database copy therefore contains no link, a new link
raises the epoch and replaces the earlier one, and changing the encryption key
ends all links. A grant is valid for 30 days by default (1 to 90), can be
revoked, and is bound to the ticket's requester (a participant of that ticket).
Issuing and disabling are audited. A link resolves only while the MAC fits, the
grant is not revoked or expired and the ticket is not in junk; every other case
shows the same page ("This link does not work") and answers `not_found`.

With the project setting "add a link to the ticket page" (Settings,
Configuration), replies and acknowledgements carry the link below the message, with
a line in the recipient's language, in HTML and plain text. It is the same link
in every mail about the ticket, so earlier mail keeps working. The worker
creates the grant when there is none and renews one that ran out, because the
mail goes to the requester anyway; a revoked grant stays revoked and the mail
has no link. The stored snapshot of a sent mail keeps the text with
`{portal-link}` in place of the address (`portalLink` says whether there was
one), because the address is a credential.

The holder sees the public conversation of that one ticket in English or German
by browser language: no private notes, no messages that were not delivered, no
staff names or addresses (replies appear under the project name), and nothing of
other tickets, participants or projects. The page is not indexed and sends no
referrer, because the link is the credential. A follow-up ticket needs its own
link. The requester counts as verified because the link goes to the address that
wrote to us; other participants need their own verification, which is not
implemented.

The customer can reply in the page (`POST /api/portal/reply`, which accepts
requests from the application's own origin only). The reply becomes a message of
the requester with `source.channel = "portal"` and no raw original: the ticket
opens again, the response obligation starts if there was none, and the language
of the text is detected and recorded like for mail while the ticket keeps its
language. A key makes a repeated submission harmless, twenty replies per hour and
link are accepted, and a ticket resolved more than 30 days ago answers
"closed" instead (the customer then writes a new message). Attachments in
replies and custom domains for the portal are not implemented.

## Translation records

`src/server/translation.ts` holds the lifecycle of derived translations; the
provider that translates is M4 work and reports through `completeTranslation`
and `failTranslation`, and the operator surfaces follow with M3. A translation is
requested for one revision of a message and one target language (English or
German for now) and is a record of its own: it never replaces the source, never
becomes a message, does not touch the ticket or its response age, and is read
with the rights to read the source. Asking again returns the same record, and a
failed one is queued again. Pending, failed and stale translations are listed
without text, so the source stays usable. A result is refused as failed when it
changes code (fenced or inline), links, addresses or placeholders (`{{x}}`,
`{x}`, `%s`, `%(x)s`) or adds one, which also stops an injected link. A result for
an outdated revision is discarded as stale. A correction of a message that was
not sent (a received message with `ticket.reply`, a private note with
`ticket.note`) gives it a new revision, makes earlier translations stale and
removes their text; it is audited. Deleting derived content is a separate
action with `ticket.reply`; deleting a ticket removes its translations. Portal
views do not include translations.

## Email designs

Each project can have versioned designs for its outgoing mail
(`src/server/email-design.ts`). A design holds
accent color, font family (sans, serif or mono), header text, an optional logo,
a footer and a signature per language (English, German). It holds no raw HTML:
texts are escaped, a signature is Markdown that goes through the same
sanitizing as message content, and a logo is a public `https` address without
credentials that recipients' mail programs load; private attachments are never a
source for it. A footer or signature for a recipient language that is missing
falls back to the project's default language, and then to nothing.

A version never changes. People with `project.manage` add a new one and select
it (version 0 is the built-in design a project has until then); both steps are
audited. The worker renders every reply and acknowledgement with the version
that is selected when it sends, through the same renderer for SMTP and the
Cloudflare API, with the plain-text body derived from the same content. The
snapshot of a sent message names the design version it was rendered with (0 for
the built-in design), so a later selection does not change what is recorded.
`previewEmail` renders a sample like a real send, with the selected version by
default, a saved version, or, for managers, an unsaved draft. The HTML carries a
dark variant for programs that follow the system appearance and scales to the
screen width.

Project managers work with designs in Settings, section "Mail design": the
saved versions with the one in use, a preview (saved version or unsaved draft, in
English or German, with the plain text), a form that starts from any version and
saves a new one, "Use" to select a version and "Send test mail". The REST
routes under `/api/v1/projects/:id/designs` and `/api/v1/test-mails/:id` back
it; there is no MCP tool, because an agent should not change how all outgoing
mail looks.

`sendTestMail` sends a test mail of a design (the selected version, a chosen
version or the built-in design, in English or German) to the address of the
person who asks and to no one else; the recipient cannot be chosen. People with
`project.manage` can do it, up to ten times an hour each, through the project's
outgoing connection (SMTP or the Cloudflare API) and the same transport path as
replies. The worker sends it as a `mail.test` job, rechecks the permission, the
connection and the pause switch, and does not replay a dispatch whose lease ran
out. It creates no ticket and no message; `getTestMail` shows the status and
the failure code to the person who asked. Rendering in Gmail, Apple Mail and
Outlook has still to be looked at in those programs; the test mail is the
means, the browser preview does not replace it.

## REST API definition

The REST API is described by an OpenAPI 3.1 document that the application
publishes without a login at `/api/v1/openapi.json`. A committed copy is in
[api/openapi.json](api/openapi.json).

Every route is listed once in the route table `src/server/api/routes.ts`: method,
path, the action that has to be granted (`x-required-access` in the document),
the input schema and the response schema. The router
(`src/server/api/router.ts`), the document (`src/server/api/openapi.ts`) and
later the MCP tools are derived from that table, so they cannot differ. The
route file `src/app/api/v1/[[...path]]/route.ts` only hands requests to the
router. All current routes are in the table; none remains in the old router.

Bodies are validated by the domain operations with the same schema objects that
the table lists, so the document describes what is enforced. Response schemas for
database rows are generated from the table definitions (`rows.ts`), so a new
column appears in the document by itself. Outside production the router checks
every JSON response against its schema and answers `500 response_mismatch` when
it differs, which the unit and browser tests therefore also verify. In
production this check is off.

After changing a route or a schema run:

```bash
sh scripts/dev.sh exec app pnpm api:docs
```

and commit the changed `docs/api/openapi.json`; a test fails when the committed
copy differs from the generated one. The document is public because it describes
the API, not data; a caller still needs a session or an agent token for every
route.

## Project configuration

The editable configuration of a project is one document: name, colour, default
language, acknowledgements, portal links, AI mode, approval policy, the outgoing
connection, a pause for outgoing mail and the hours after which an unanswered
ticket is overdue (24 by default, 1 to 720). Connections themselves, secrets and texts
are not part of it. It is read with `GET
/api/v1/projects/{id}/config`, which also returns its `version`, and replaced with
`PUT` on the same path. A write names the version it read (`expectedVersion`); a
change made in between answers `409 stale_version`. An optional
`idempotencyKey` makes a repeated request have the effect of one.

`PUT ...?validate=true` writes nothing and reports the diff and what a real write
would do. Errors for an invalid body name the offending field as a JSON pointer in
`issues`.

Three actions govern it: `config.read`, `config.write` and `config.approve`. People who
manage a project hold all three (a migration added them). An agent token can carry
`config.read` and `config.write` but never `config.approve` or `agent.manage`.

A person with `config.write` applies a change at once. An agent applies it at once
only when the project's `approvalPolicy` is `direct`. Under `review`, the default,
the change becomes a proposal (`202`) that a person with `config.approve` activates
or rejects at `POST /api/v1/config/changes/{id}/decision`; an agent cannot decide,
not even its own proposal. A proposal on a version that has changed since is
superseded and never applies. The approval policy itself is changed only by a
person with `config.approve`. Every applied and proposed change is kept with its
diff in `config_change` and audited. The older settings route
`POST /projects/{id}/settings` still works and raises the version as well.

## Connections

A project reads mail through inbound connections (IMAP, or Cloudflare Email
Routing through R2) and sends it through one outgoing connection (SMTP, or the
Cloudflare Email Sending API). Connections are managed through the API under the
action `integration.manage`:

- `GET /api/v1/projects/{id}/connections` lists them. A connection shows its
  non-secret configuration, `status` (`draft`, `ready`, `degraded`, `disabled`),
  `lastErrorCode`, `version` and whether a secret is stored (`secretSet`). The
  secret is never returned, not in a diff, a proposal or an audit entry.
- `POST .../connections` defines one. The body names `kind`, `direction`, `name`,
  `config` and `secret`; the published definition lists the fields of each kind. A
  connection is accepted only if the adapter can use it: IMAP needs TLS, SMTP needs
  TLS or port 587, Cloudflare inbound needs HTTPS, and a connection may not point at
  the machine itself or the link-local range (`127.0.0.0/8`, `169.254.0.0/16`, `::1`,
  `fe80::/10`, `localhost`). Private networks stay allowed; names are not
  resolved, so this limits mistakes and does not replace network policy. The flag
  `developmentOnly` is accepted only on the development stack.
- `PUT .../connections/{id}` changes the name, the configuration or the secret. It
  names the version that was read (`expectedVersion`). A changed connection returns
  to `draft`, and nothing is sent or read through a `draft` connection until a test
  succeeds. Leaving the secret out keeps the stored one.
- `POST .../connections/{id}/test` checks login and mailbox (IMAP), the bucket
  (Cloudflare inbound), the login (SMTP) or that the token is active (Cloudflare
  outbound) and records `ready`, or `degraded` with a code (`auth_failed`,
  `connect_failed`, `timeout`, `tls_failed`, `not_found`, `failed`) that names no host
  or credential. It sends and reads no mail. For Cloudflare outbound it cannot tell
  whether the token may send; that is known only by sending.
- `POST .../connections/{id}/disable` stops all use of the connection.

Every write accepts `?validate=true`, which reports the diff without writing, and an
`idempotencyKey`. The approval policy of the project applies as it does to the
configuration: a person applies directly, an agent proposes under `review`, and a
person with `config.approve` decides at `/config/changes/{id}/decision`. A proposal
keeps the secret sealed with the encryption key, like the stored one. The outgoing
connection is chosen in the project configuration (`outboundConnectionId`), which
accepts only an outgoing connection of the project that is not disabled.

The settings page lists the connections with their status and offers test and
disable; it has no form for credentials.

## Texts

A project can set its own wording for a fixed set of texts, in English and in German:
the acknowledgement mail (`acknowledgement`, with `{number}`), the line before the
ticket link in a mail (`portalLink`) and the texts of the customer page
(`portal.request` with `{number}`, `portal.conversation`, `portal.you`,
`portal.reply`, `portal.send`, `portal.closed`, `portal.limited`, `portal.failed`).
The built-in wording stays in use wherever a project sets none, and for any other
language the English text applies, as before. The texts of an expired or unknown
link have no project and keep the built-in wording.

- `GET /api/v1/projects/{id}/texts` lists every text with its built-in wording, the
  project's own wording, the placeholders and the `version` to name when changing it
  (0 when the project never set it).
- `PUT /api/v1/projects/{id}/texts/{key}/{language}` sets the wording, or returns it
  to the built-in one with `{"text": null}`. It needs `config.write`, names the
  version that was read, accepts `?validate=true` and an `idempotencyKey`, and follows
  the approval policy: a person applies, an agent under `review` proposes.
- `GET .../texts/{key}/{language}/versions` lists the versions, newest first. Every
  change, including a return to the built-in wording, is a new version.

A text may contain the placeholders of its key and no other braces; a required
placeholder must be present, an apostrophe may not touch a brace (the customer page
reads ICU messages), and the text is at most 2000 characters. The rules are checked
on write, and an error names the field (`/text`).

## Overview and list size

The overview counts in the database over every ticket of the authorized
projects, not over the loaded part of the list (`getOverview`, `GET
/api/v1/overview`): per project the total, the overdue tickets (unanswered
for 24 hours unless the project set another limit), the open ones nobody handles, the due reminders and the ones waiting
for the customer, plus the eight oldest unanswered tickets of each project.
Junk is not counted. The desk sums the projects that the project filter
selects.

The ticket list is loaded in steps of 250, oldest unanswered first, and up to
2000 (`?limit=` on the page and on `GET /api/v1/tickets`). When fewer tickets
are loaded than exist, the list says so and offers to load more. Views such as
Waiting, Resolved and Reminders filter the loaded tickets, so beyond the first
step they can be incomplete; the counts in the overview are not. Search runs on
the server and is not affected.

## Tags

Tags are the team's own labels on a ticket, for finding it again. They are not
shown to the requester. A tag is normalized before it is stored (Unicode NFKC,
lowercase, spaces become hyphens) and must then match letters or digits first,
then letters, digits, hyphen or underscore, 30 characters at most. A ticket
carries at most ten. Saving replaces the list as a whole, needs `ticket.note`,
is written to the audit trail as `ticket.tags` and leaves the revision alone,
so a reply that is being written is not affected.

`GET /api/v1/tags` lists the tags in use in the authorized projects, most used
first, junk excluded. Search also matches tags. The desk shows the tags on each
row, offers the ones in use as a filter over the list and suggests them when a
tag is added. MCP does not offer tags yet; the ledger in
[capabilities.md](capabilities.md) records the difference.

## Reminders

A reminder is a time at which the team wants to see a ticket again
(`POST /api/v1/tickets/:id/reminder` with `{"remindAt": <ISO time or null>}`; in
the ticket header: a date and time, "Tomorrow 9:00", "In a week, 9:00", "Clear
reminder"). It needs `ticket.note` in the project, is private to the team and
does not change the conversation, so the revision that protects replies and the
draft that is being written stay as they are. A time in the past is due at once
("Done" clears it); more than a year ahead or back is refused; tickets in junk
take none. The overview counts the reminders that are due, the "Reminders" view
lists every ticket with one (soonest first) and a ticket row shows it. Setting and
clearing are audited. The time is stored as an instant; the input uses the
browser's time zone. There is no notification when a reminder falls due: it
shows in the overview and the list, which the operator opens anyway.

## Search

The search field in the inbox asks the server once the text has two or more
characters (`GET /api/v1/tickets/search?q=`, MCP `tickets_search`). A ticket
matches when the text is in its subject, the requester's name or address, or any
of its messages, including private notes of tickets the caller may read; matching
is case-insensitive and `%`, `_` and `\` are literal. Only authorized projects
are searched and the authorization is part of the query, so no ticket of
another project is matched or counted; naming a project that is not authorized
answers `not_found`. Tickets in junk are left out, results are the 50 most
recently updated, and a hit shows a snippet of the first message that contains
the text. The list is not limited to the 250 tickets loaded in the inbox. The
search is a case-insensitive substring match without an index, which is
adequate for the development scale; a trigram or full-text index is needed
before the production scale is qualified. A single character still filters the
loaded list.

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

The test database `aidesk_test` is shared by every branch of a checkout. Before
the tests start, the global setup compares the migrations the database has
applied (their SHA-256 hashes, as drizzle records them) with the SQL files of the
checked-out branch; when the database holds one the branch does not have, it is
emptied and migrated again, because the schema would not be the one the code
expects and drizzle skips a migration that is older than the last one applied.
The development database `aidesk` is never touched.

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

Done in code for M2 (see the sections above and the evidence in issue #3): inbound
core with IMAP and Cloudflare, threading and reopen rules, private attachments,
extraction, acknowledgements, junk with IMAP follow-up, late bounces, language
decision, translation records, versioned mail designs with preview and test mail,
sent mail snapshots, channel review.

Done for the first slices of M3 (evidence in issue #4): the customer portal with
derived links and an optional link in outgoing mail, the original mail as a safe
view, design settings, server-side search across all authorized tickets,
reminders, tags and an overview counted on the server. Two
server operations have no surface yet: translation records
(`src/server/translation.ts`, for the M4 provider and the M3 translation
display) and the sent snapshot (`getSentSnapshot`). They are not listed in
`docs/capabilities.md` until a surface exists.

Still open for M2: real IMAP/SMTP qualification with a provider mailbox (M2-A9), a
check of the rendered mail in Gmail, Apple Mail and Outlook (M2-A5; the test mail
exists), and a provider webhook for bounces under SMTP2GO.

Still open for M3: views over the complete dataset beyond the first list step
(the counts of the overview are complete; the Waiting, Resolved and Reminders
views filter what is loaded), custom portal domains, attachments in portal
replies, display of translations in the ticket, assignment and AI states, the
configuration of connections in the interface, and the observed walkthrough and
manual accessibility checks (M3-A3, M3-A7).

Real OIDC/SAML provider qualification, provisioning/recovery/MFA, translation jobs
with a real provider, named AI assignment/runners, knowledge/GitHub, escalations
and operational health are still milestone work. The inbox list loads in steps up to
2000 conversations; the search does not have that limit but has no index yet, so
neither qualifies the planned production scale. Messenger adapters are reserved in
the plan and in `src/domain/channels.ts` and are not presented as working
connections.

Vercel HTTPS, a hardened production Docker target, real remote MCP, browser and
usability/accessibility runs, repository-settings audit, backup/restore,
retention/export/deletion and measured recovery targets also remain open.
Do not equate a passing development build with these qualifications.
