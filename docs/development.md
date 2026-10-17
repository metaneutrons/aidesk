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
`OWNER_CLAIM_TOKEN` after the claim. The setup asks for the password twice.

An owner who lost the password sets a new one at `/recover` (a link on the sign-in with a password).
The page needs `OWNER_RECOVERY_TOKEN` (32 characters or more, a secret of the deployment that can stay
set; without it the recovery does not exist, and the claim token does not work for it). Step one takes
the token, the address and the new password (twice) and prepares a pending recovery, kept encrypted for ten
minutes; step two needs a code of the authenticator or an unused backup code and sets the password.
The sessions of the owner end, a used backup code is spent, a lock of the second factor is lifted, and
`owner.password_recovered` is written to the audit log. The answers do not tell whether an address belongs
to an owner (a wrong address, an operator and an owner whose second factor is off are refused like a wrong
code), a pending recovery allows five wrong codes, and ten recoveries can start in an hour. An owner
who has lost the password and the second factor has no way back in the product: the person who runs
the deployment has to set a password in the database.

An owner can register **passkeys** in the settings (the section "Passkeys", for owners only). After the
password, the sign-in page offers the passkey first; the code of the authenticator app and the backup
codes stay as the way back ("Use a code instead"). A passkey is a discoverable credential with user
verification required, and it is the second factor only: the verification of an assertion needs the pending
step that the password leaves (a signed cookie), the passkey has to belong to the user of that step, the
device has to have verified the user, and the step is used up by it. Without the password step there is
no passkey sign-in (the routes of the plugin answer 401), and registering needs a fresh session of an owner.
A successful sign-in writes `owner.recovery_sign_in` with the method `passkey` to the audit. The relying
party is the host name of `APP_URL`: a change of `APP_URL` to another host makes the registered passkeys
unusable until they are added again. The routes are those of the passkey plugin of Better Auth under
`/api/auth/passkey/*` and the status route `/api/auth/owner-passkey/status`; they are not part of the REST
definition.

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

### Tools

The tools an agent sees follow its token: a tool is offered when the token holds the
action of its route in at least one project. Five tools are written by hand
(`projects_list`, `tickets_list`, `tickets_search`, `tickets_get`, `tickets_reply`).
All others come from the route table (`src/server/api/routes.ts`), where every route
says how it reaches MCP: as a tool, as one of the hand-written tools, or not at all
with the reason. A tool takes the path parameters, the query and the body of its
route as one set of arguments, runs the same operation as REST and returns the same
JSON. A failure returns an error result that names the field (`issues[].pointer`), so a
client can correct the call. The published API definition carries the name of the
tool in `x-mcp-tool`.

Offered: `config_get`, `config_put`, `config_changes`, `connections_list`,
`connections_create`, `connections_update`, `connections_disable`, `connections_test`,
`texts_list`, `texts_versions`, `texts_set`, `overview_get`, `tags_list`,
`tickets_set_tags`, `tickets_set_status`, `tickets_assign`, `attachments_read` and
`messages_read_original`. Not offered, with reasons in `docs/capabilities.md`:
everything that issues credentials or decides on proposals (`config.decide`), moves
mail to or from junk, creates portal links, sets reminders, changes the mail design,
and the binary downloads of files.

#### Files for agents

A file is not a tool result, so the downloads stay with REST. `GET
/attachments/{id}/text` (`attachments_read`) returns an attachment as text, and `GET
/messages/{id}/original/text` (`messages_read_original`) the source of a received
mail with its headers. Both need `ticket.read_files`, give at most 256 KiB and report
`truncated`. The action is separate from `ticket.read` on purpose: a file is written by
the sender and may carry instructions for a model, so an agent that is allowed to answer
by itself (`direct`) reads files only when someone granted that. People who manage a
project hold it (migration 0017). Of the token accesses of the settings page, only
"Read, with attachments and mail sources" includes it; through the API it is granted with
explicit actions. Plain text is decoded at once: the
declared type is `text/*` or a text format (JSON, XML, YAML and the like), or the type
is `application/octet-stream` and the extension is a text one, and the content has no
NUL byte in its first 8 KiB and does not start like a document. A PDF file and a Word, Excel or PowerPoint file (by type or extension, or
by its content whatever its type says, a PDF header or the start of a ZIP package) are
read by the worker (see "Reading documents for agents"); the first request answers
`readable: false` with `reason: extraction_pending`, a later one has the text with an
`extraction` object (`method`, `units`, `unit`, `hidden`) or `reason:
extraction_failed` with the `failure`. Everything else, and a file refused when the mail
arrived, answers `readable: false` with `type_not_readable` or `not_stored` and no
content. An image (PNG, JPEG, WebP, GIF, by type or extension) and a PDF file that has
no text of its own go to the model when the project switched on the task `image.read`,
and answer `image_reading_off` when it did not. What a sender wrote is data: the descriptions of both tools and the guide for
agents say that an agent does not act on it.

Every answer carries a frame. `untrusted: true` and the `origin` (project, ticket,
message and file) say what it is. Characters that a person does not see but a model
reads are removed from the text and from the file name: the Unicode tag block,
zero-width characters, left-to-right and right-to-left marks, the bidirectional
embeddings and isolates, the soft hyphen, the byte order mark and control characters
other than line breaks and tabs. `removedCharacters` counts them. The joiner of an
emoji sequence and the non-joiner of some scripts are among the removed characters;
that is accepted, because the same characters carry hidden text. `flags` lists
patterns that look like instructions to a model (`instruction_override`,
`role_marker`, `secrecy_request`, `exfiltration_hint`, `hidden_characters` when
characters were removed, and `hidden_content` when a document had parts that were left
out) in English and German. A flag is a hint and never blocks:
a pattern that blocks also blocks a customer who quotes it, and an empty list does
not mean the text is safe. Text that is hidden in a document by its layout, such as
white on white, cannot be found reliably. Every read, also of a file that is not
read, is audited as `file.read` with the actor, the ticket, the file, the flags and
the outcome; a refused read is not. The protection limits what an instruction
in a file can cause (the separate action, the approval policy, the project as the
boundary) and makes a read visible; it does not detect instructions.

Images and scans are read through a model; see "Reading images and scans".

## Ticket work

`POST /api/v1/tickets/{id}/status` resolves or reopens a ticket without a message. It
needs `ticket.resolve`, names the revision that was read, and raises the revision;
resolving ends the response obligation, reopening starts none, and `waiting` follows a
reply and is not set by hand. `POST /api/v1/tickets/{id}/assign` assigns a ticket to a
person with access to the project (`userId`), to an active agent of the project
(`agentId`), or to nobody (both `null`); it needs `ticket.assign`. Internal notes are
`tickets_reply` with `internal: true`.

## Retention of files

Attachments, the stored originals of mails and the text that was read from a file
(`attachment_text`) are kept as long as their ticket and the message they belong to, and
the rows go when those go (the foreign keys cascade). The files themselves are objects in
the private storage, and a database cascade does not remove them. There is no retention
period of their own, by decision of the product owner of 2026-10-15, and no route deletes
a ticket today. The rule for the objects: they are named by what they hold
(`inbound/<project>/<checksum>.eml`, `attachments/<project>/<checksum>`), so one object can
be the file of several attachments or the original of several messages, and the code that
deletes a ticket cannot know whether another ticket still uses an object. An object is kept
as long as any row names it, and one that no row names is removed by a sweep:
`pnpm tsx scripts/sweep-objects.ts` lists such objects (a dry run) and
`pnpm tsx scripts/sweep-objects.ts --delete` removes them. An object that is younger than
24 hours (`--grace-hours=N`) is kept, because an object is stored before the row that
names it. Whoever adds a way to delete tickets leaves the objects to the sweep and runs it
after the deletion; the sweep also finds what a restored database no longer names. The
consequence for data protection is that the text of a file is a second copy of customer
content in the database, as long as the file is, and that an object of a deleted ticket
stays in the storage until the sweep ran.

## Reading images and scans

An image has no text, and a scanned PDF has none in its text layer. Both are read by a
model, through the same boundary as every task (`runAiTask`, see "Running a task"), as
the task `image.read` of the project. It is a profile like the others: off until a
person with `config.approve` switches it on, with a connection, a model and the limits
(a transcription of a page can need more than the default 4000 output tokens, and a
profile may set up to 16000; a model that thinks spends output tokens on it). The provider of that connection receives the customer's
file; that is why a person switches it on and why nothing is sent while it is off. The
model has to take images, and for a scanned PDF it has to take PDF files; the product
does not check that, and a model that does not answers with a provider error.

- **Routing.** `attachments_read` sends a file whose name says PNG, JPEG, WebP or GIF to
  the model path and a PDF file to the reader of documents first. When the reader finds
  no text (`empty`), the file goes to the model path as a scan. Without a profile that
  is on, the answer is `image_reading_off` and no job is queued. Other image types
  (HEIC, TIFF, SVG, BMP) are `type_not_readable`.
- **What is sent.** Only what its first bytes show to be a PNG, JPEG, WebP, GIF or PDF,
  whatever the sender called the file, as bytes in the request and never as an address
  that the SDK or the provider would fetch. Up to 5 MiB for an image and 10 MiB for a
  PDF file; beyond that the result is `too_large`, with no call. The system text says
  that the file comes from a third party and that what it says is content to
  transcribe; the answer is framed as untrusted when it is read, like any file.
- **Budget.** The file counts against the daily budget before the call: an image as
  one third of its bytes up to 8000 tokens, a PDF file as a tenth of its bytes up to
  200 000, and the provider's count settles the run. A large scan can therefore be
  refused by a small budget (`ai_budget_exceeded`).
- **Job and record.** The first request queues the job `attachment.read_image` (one per
  file), and the worker runs it once. The text is kept in `attachment_text` with the
  method `ai:<model>`, as long as the file is, and is not asked for again; a change of
  the reader of documents does not discard it. What the model found (nothing to read)
  and what the product found (not an image, too large) are kept as failures like any
  reading. A run that ended for a reason of the moment (`ai_timeout`,
  `ai_quota_exhausted`, `ai_model_unavailable`, `ai_rate_limited`, `ai_provider_error`,
  `ai_budget_exceeded`, `ai_not_configured`, `ai_disabled`) is
  kept as a failure, is not repeated by the worker (its outcome may be unknown and may
  have cost something), and is asked for again by the first request after five
  minutes. A failure of the machinery before the run (the storage) is retried like in
  the reading of documents, and the lease of the job is longer than the longest
  timeout of a profile, so that a run that is still going is not taken for a lost one.
- **Marked as read by a model.** `extraction.method` starts with `ai:` and names the
  model. Such a text can misread characters and figures, and the guide for agents says
  so. The run is recorded in `ai_run` with the person or agent that asked first, and
  the read is audited as `file.read` like any other.

## Reading documents for agents

The building block that reads the text of PDF, Word, Excel and PowerPoint files is
in `src/server/extract` (C5-A4). `attachments_read` uses it through the worker:
the first request for a PDF or Office file queues the job `attachment.extract` (one
per file and version of the reader) and answers `extraction_pending`; the worker
reads the file in the closed process and keeps the result in the table
`attachment_text` (text, method, units, hidden parts, or the failure), which follows
the attachment when it is deleted. Later reads come from that record, also for a file
that could not be read, so that a file cannot be made to cost a reading again and
again. A result of another version of the reader (`extractorVersion`) is not used and
is asked for again. A failure of the machinery around the reading, such as a storage
that does not answer, is retried after 30 s, 2 min, 10 min and 1 h and then goes to
review, which the answer shows as `extraction_failed` with `failure: failed`. The
extracted text is kept as long as the file is; the rules for how long attachments are
kept are not decided.

- **What is read.** The text layer of a PDF file (pdf.js, official `pdfjs-dist`,
  pinned), and the text of `.docx`, `.xlsx` and `.pptx` files. Old binary Office
  files and password protected Office files (both share the OLE container) and
  everything else are `unsupported`; a PDF with a password is `encrypted`. What a
  file is follows from its content, not from its name or declared type.
- **The Office reader is small on purpose.** It unzips with `fflate` and reads the
  runs of text of the few parts that hold them. It is not an XML parser: a part that
  declares a document type or an entity is refused (an Office file never does), so
  no entity can expand, and only the five predefined entities and numeric
  references are decoded. Speaker notes and comments are not read.
- **Hidden text is left out and counted** in `hidden`: Word runs that are hidden,
  set in white or in a size nobody reads, hidden sheets, rows and columns of Excel,
  hidden slides, and PDF text too small to read. Text outside a PDF page is not
  returned by pdf.js at all. This reduces a channel for hidden instructions; it does
  not close it, since text can hide in other ways.
- **Limits.** 15 MiB per file (the ingest limit), 2000 parts and 64 MiB unpacked per
  package and 32 MiB per part, judged on the declared sizes, 200 PDF pages, 200 000
  cells and 1 MiB of text kept per file. Beyond a limit the answer says `too_large`
  or `truncated`.
- **A closed process.** pdf.js has had flaws that ran a script of the file, so the
  files are read in a process of their own (`sandbox.ts`): Node's permission model
  without network, without the right to write, to start a process or a worker, with
  the right to read only its own program file, with one harmless environment
  variable and without the secrets of the worker, a ceiling for the heap and for the
  resident memory of the whole process (the heap flag does not count buffers, so the
  parent watches it), and a time limit. Its answer is believed only when it has the
  shape of a result. The program is the reader and its libraries bundled by `esbuild`
  into one file under the temporary directory, built once per version of the
  sources. The tests run a probe program in the closed process and the same program
  without it, so they can tell whether the closing works.
- **Choice of libraries**, checked on 2026-10-14 against the registry and the GitHub
  advisories, not from memory. `pdfjs-dist` 6.4.299: a flaw that ran a script was
  fixed in 6.2.108, and version 6 no longer evaluates fonts. Not used: `unpdf`
  (bundles pdf.js 6.1.x, below that fix), `officeparser` (pulls in `tesseract.js`,
  which loads language data from the network, against the decision to read images
  through the model of the project), `mammoth` and `fast-xml-parser` (a parser with
  a long list of entity flaws is more than the task needs). `@napi-rs/canvas`, an
  optional native part of pdf.js, is excluded in `pnpm-workspace.yaml`.

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

### AI at intake

Two steps of the intake can ask a model, each switched on by the profile of its own task
(`intake.extract`, `intake.junk`; off by default, and switching on needs `config.approve` like every
AI task, because the mail text goes to the provider). They are independent, optional and run for
every admitted mail from both adapters (IMAP and Cloudflare), because both end in `processIngress`.

- **Where.** After the raw mail is stored and before the transaction that creates the ticket: the
  calls are made outside the transaction, in parallel, each with at most 30 seconds of wait (the
  profile's timeout when it is shorter). A mail that the rules call junk, a delivery report and a
  copy of a mail that is already in are not asked about (so they cost nothing); a reply to a ticket
  is asked for its new content but not whether it is junk, and a mail that a person restored is not
  classified again. The results are stored with the mail (`ingress.classification.ai`), so a mail
  that is processed again after a crash, or after a person put it aside while the model answered, is
  not sent to the model again. A result is stored also when the call failed: a request that may have
  been accepted is not made twice.
- **Extraction.** The model gets the lines of the mail, numbered, between marker lines with a random
  value, and answers by calling a tool with ranges of line numbers; the product assembles the new
  content from those lines of the mail. The model never writes the text that people read, so an
  instruction in a mail cannot put words of its own into the ticket. Ranges that do not fit the
  mail (past its end, backwards, none) or an answer without the tool call are a failure. A mail over
  30,000 characters is not sent. Whatever the model answers, the parser result stays: when the
  model's lines are used the message says `extraction: ai` and keeps the parser's text
  (`source.parser`) next to the original mail; when they are not, `extraction: parser` and
  `extractionFailure` name why (`no_selection`, `bad_selection`, `context_limit`, or the code of the
  AI boundary such as `ai_budget_exceeded`). The desk shows both, and the parser's text on request.
- **Junk.** The model gets the sender, the subject, the first 3,000 characters, the number of
  attachments and a few header signals, and answers `junk`, `support` or `unsure` with a kind
  (advertising, phishing, newsletter, automated, other). The rules stay the floor: a mail that they
  call junk is junk, and `support` does not clear it. Only `junk` for a mail that would start a
  ticket keeps it out of the inbox (state `junk`, `source: ai`, the kind as reason), where a person
  can restore it like any other junk, with the IMAP mailbox following. `unsure` and a failure leave
  a ticket like any other, marked on its first message (`junkCheck: uncertain | failed`), and the
  acknowledgement is not sent for it: the product does not answer a mail that it could not clear
  before a person has looked at it.
- **Failure never loses a mail.** A step that is off, over budget, refused, slow or unusable leaves
  the parser and the rules as the result, and the failure is visible on the message.

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
"closed" instead (the customer then writes a new message).

A reply can carry files (a form with the fields `token`, `markdown`, `idempotencyKey` and `files`;
the JSON form without files still works). They are held to the rules of a received mail
(`attachmentRefusal`: programs and installers, 15 MB a file) and to a stricter limit of ten files and
30 MB together; a file that breaks a rule refuses the whole reply with 422 and the code
(`attachment_type_blocked`, `attachment_too_large`, `attachment_count_exceeded`) and nothing is kept.
Accepted files are stored under their checksum and become attachments of the message, which staff
see and read like those of a mail (and which agents read behind `ticket.read_files`); the customer's
page lists their names and offers no download. A body of more than 31 MB is not read (413). Custom
domains for the portal are not implemented.

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

### Guide for agents

A short guide tells an agent what to read first, how versions, `?validate=true`,
`idempotencyKey` and proposals work, what a draft is and what a token can never
do. Its text is `src/server/api/guide.ts`. It is served without a login at
`/api/v1/guide.md`, linked from the definition (`externalDocs`), handed to MCP
clients as the instructions of the server when they connect, and kept as
[api/agent-guide.md](api/agent-guide.md). `pnpm api:docs` writes the copy, and a
test fails when it differs. Change the guide together with the behaviour it
describes.

### Contract tests

`tests/e2e/contract.spec.ts` reads the published definition from the running
application, as a client does, and checks answers against it with Ajv, a JSON
Schema validator that is independent of the zod schemas the definition is built
from. It makes three checks:

- every route that can be called with data of the fixture project is called, and
  its status has to be documented and its body has to match the schema of that
  status (reads, ticket work, dry runs of configuration and texts, designs,
  agents and the webhook cycle);
- every route is called without a login and, signed in, with ids that do not
  exist and an empty body, and the refusal has to match the documented error
  shape;
- a changed answer fails: a missing required property, a changed type, a property
  the definition does not know and an undocumented status are each rejected.

A route that is neither called nor named in `notCalled` with a reason fails the
test, and so does a reason for a route that no longer exists. Routes that need a
real mail host, a stored original or an agent draft are listed there and covered
by their own tests. The test runs in the Browser tests job against the same
stack and only on Chromium, since it tests the protocol and not a browser.

## Project configuration

The editable configuration of a project is one document: name, colour, default
language, acknowledgements, portal links, approval policy, the outgoing
connection, a pause for outgoing mail and the hours after which an unanswered
ticket is flagged as late (`warnHours`, 4 by default) and is overdue (`overdueHours`, 24 by
default; both 1 to 720, the first never later than the second). Connections themselves, secrets and texts
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
  `fe80::/10`, `localhost`, and the same addresses in IPv4-mapped form). Private
  networks stay allowed. A host name is resolved and every address it resolves to
  has to be allowed; a name that does not resolve is refused. This is checked when a
  connection is saved and again on every test, which records `host_refused` when a
  name has come to point somewhere refused. It cannot stop an address that changes
  between a test and a use (DNS rebinding), so it does not replace network policy.
  The flag
  `developmentOnly` is accepted only on the development stack.
- `PUT .../connections/{id}` changes the name, the configuration or the secret. It
  names the version that was read (`expectedVersion`). A changed connection returns
  to `draft`, and nothing is sent or read through a `draft` connection until a test
  succeeds. Leaving the secret out keeps the stored one.
- `POST .../connections/{id}/test` checks login and mailbox (IMAP), the bucket
  (Cloudflare inbound), the login (SMTP) or that the token is active (Cloudflare
  outbound) and records `ready`, or `degraded` with a code (`auth_failed`,
  `connect_failed`, `timeout`, `tls_failed`, `host_refused`, `not_found`, `failed`) that names no host
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

The settings page lists the connections with their status and offers test, edit and
disable, and a form to add one (`src/components/connection-form.tsx`): a field for each
setting of the kind, a password field for each credential, and the errors of the API shown
with the field they name. A credential is typed there and is never shown again; changing a
connection keeps the credentials that are left empty, and replaces them all when any is filled.
An agent under the review policy still proposes a change, which a person approves.

### Model providers

A project can connect a model provider: the kinds `anthropic`, `openai` and `google`
with the direction `ai` (C6-A1). They follow the rules above. The configuration is
an optional `endpoint`, the base address that the paths of the provider are added to,
for a gateway or a regional address; without one the provider's own address is used.
An `endpoint` has to be HTTPS, passes the host guard like any other host and is
checked again on every test; `developmentOnly` allows a plain address on a
development stack. For `anthropic` there is an optional `workspaceId` (`wrkspc_…`): a key
that is not made inside one workspace is refused with 400 ("must include the
anthropic-workspace-id header") unless that header names the workspace, and the test and
every run then send it. A key made inside a workspace needs none, and the other kinds do
not take the field. The secret is `apiKey`, stored sealed and never returned. A project
can have several.

A test asks for the list of models, which needs the key and costs nothing:
`GET /v1/models` with `X-Api-Key` and `anthropic-version: 2023-06-01` (Anthropic),
`GET /v1/models` with `Authorization: Bearer` (OpenAI) and `GET /v1beta/models` with
`x-goog-api-key` (Google). The key goes in a header and never in the address, and a
redirect is not followed, since it would take the key to another host. A status of
`401` or `403` is `auth_failed`, `429` is `rate_limited`, any other failure of the
provider is `provider_error`; the codes name no host and no key. The paths and
headers of Anthropic and OpenAI were checked against their documentation on
2026-10-15. The documentation of Google shows the key as a query parameter for the
list of models and the header for other calls; the header is used so that the key
is not in an address, and it has not been tried against the live service. A
connection says that a project may reach a provider; which task runs on which model,
and whether ticket content may be sent at all, is decided by task profiles (C6-A2).

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

## Replies by agents

The approval policy of a project also governs replies to customers. Under `review`,
the default, a reply that an agent writes (`POST /tickets/{id}/reply` or
`tickets_reply` with `internal: false`) is stored as a draft: it is not sent, the
ticket and its revision stay as they are, and the answer says `draft: true`.
Internal notes are not drafts. A person with `ticket.reply` sends the draft with
`POST /messages/{id}/send` or discards it with `POST /messages/{id}/discard`; the
desk shows a draft with these two buttons. Sending is refused with a conflict when
the ticket changed since the draft was written (a customer wrote, someone answered,
the ticket went to junk), so a draft never goes out on a conversation it was not
written for; the agent writes it again. A draft that resolves needs `ticket.resolve`
of the person who sends it. The mail goes out as sent by that person, and the audit
names the agent's draft and the person who sent it. An agent cannot send or discard
a draft, also not its own.

The desk lists the links of a draft under the draft, each with the text a reader
sees and the address it goes to, taken from the same sanitized HTML that the mail
will carry (so an anchor written as HTML in the Markdown is listed too). A link
whose text is itself an address of another host than the link goes to, such as
`[https://bank.example/login](https://evil.example/steal)`, is marked, because that
is how a link is made to look harmless. Only a draft shows links; the API returns
them as `links` of the message. Markdown for an image makes no image in the mail:
`img` is not an allowed tag, so an agent cannot leak data through the address of an
image, and the plain-text part of the mail has neither the image nor its address. A
link stays a link, and the person who sends the draft is the check.

Under `direct` an agent's reply is queued at once, as before; the agent has to be
assigned to the ticket, and a project can still stop agents (`stopAutonomous`). If a
project is switched back to `review` while such a reply is queued, the worker does
not send it and the job goes to review. The earlier setting `aiMode` no longer
exists; a migration made every project that had it on `autonomous` a `direct` project.

## Managed agents

Part P1 of [the completion plan](plans/m4-completion.md). A managed agent is an agent record
that the product runs itself (`agent.managed`): it has a name and grants, which cap what a
model working for it may do, and no token that anyone knows (the stored hash is of a secret
that was thrown away). A person with `agent.manage` creates one with
`POST /projects/{id}/agents/managed`, with grants that do not exceed their own and never
`agent.manage` or `config.approve`; an agent cannot create agents, so MCP has no tool for it. The
settings page creates one from the form that issues tokens: the box "Run by aidesk" hides the
validity, posts to this route and shows the agent as "Managed agent" in the list, where it is
revoked like a token. External agents with a
token work as before and their model settings are not controlled by aidesk.

A **run** (`agent_run`) is the work of a managed agent on one revision of a ticket. It is
executed by the job `agent.run` and is what a person sees (`GET /tickets/{id}/agent-runs`, the
tool `tickets_agent_runs`) and what the worker checks again before it acts. Its states are
queued, running, draft_ready, sent, resolved, noted, nothing_to_do, cancelled, failed and
needs_person.

- **Queued** when a ticket is assigned to a managed agent and when a customer writes on a
  ticket that is assigned to one (mail and portal), for the revision at that moment, once:
  asking again for the same revision gives the same run, and a run that was cancelled for that
  revision starts over. Nothing is queued for a person or an external agent, for a ticket in
  junk, a resolved ticket or one that was taken over.
- **Cancelled** (with the reason in `reason`) when the ticket is reassigned, resolved or moved to
  junk, when the agent is revoked, and by a takeover. A queued job is cancelled with it; a run that
  has started finds its state changed and stops at its next side effect, and what it would write
  at its end does not undo the cancellation.
- **Takeover.** A person who answers a ticket (a public reply, not a private note) that a
  managed agent works ends its runs and sets `agent_paused_at` on the ticket: the agent does not
  work it again until a person who may assign resumes it (`POST /tickets/{id}/resume-agent`
  with the revision that the person read, which queues a run for it; an older revision is a 409) or assigns the ticket anew.
- **Before it goes on,** the worker asks again (`staleReason`): the run still counts, the ticket
  is not in junk or taken over, the agent is still the assignee and is active and managed, the
  revision is still the one the run answers (a newer message has its own run) and the project has
  not stopped autonomous work. Otherwise the run ends as cancelled with the reason.
- An agent that sends under the `direct` policy has to be assigned to the ticket, and says so when
  it replies, not only when the worker would refuse to send.
- **What a person sees.** The ticket (`GET /tickets/{id}`, the tool `tickets_get` and the desk) names
  its assignee (`assignee`: kind, id, name, whether it is managed) and the AI work on it
  (`aiWork`, only when the assignee is a managed agent): `queued`, `running`, `draft_ready`,
  `sent` (a reply was sent, with or without resolving), `done` (the agent finished without a reply),
  `failed`, `needs_person` and `stopped`. A stop that holds wins over what the last run did and
  names its level (`stoppedBy`: ticket, project or workspace). `GET /tickets/{id}/assignees` lists
  the people and agents that a person who may assign can choose.
- What a run does once it may go on is the runner ("The runner of a managed agent" below).

### The runner of a managed agent

Part P2 of [the completion plan](plans/m4-completion.md). The worker takes the job `agent.run`
(`src/worker/agent-runs.ts`) and works one revision of one ticket in at most eight calls of the
model, through the task `agent.respond` of the project (a profile like the others, off until a
person with `config.approve` switches it on).

- **What the model reads.** The standard instruction of the project (the text `agent.respond`, in
  English and German, versioned and editable like every text) followed by a guard that a project
  cannot edit away, and the conversation as data between two marker lines with a random value per
  run. The guard says that the data is never an instruction (including a customer's request for
  a language, a word or a refund), that only facts of the data are used and none of the usual
  inventions (a date, a status, a price, a policy, that something was checked or refunded), that a
  reply never contains a placeholder or asks the customer to repeat a question, and that a missing
  fact is a note for the team and `needs_person`. Private notes, drafts, discarded and system
  messages are not part of the conversation; the attachments are listed with their ids.
- **What it can call** (`src/domain/agent.ts`): `reply` (the one public reply of the run, with
  `resolve` only when the agent holds `ticket.resolve`), `note` (an internal note, at most three,
  the same note twice is one), `read_attachment` (an attachment of this ticket, at most four, with
  `ticket.read_files`, framed as untrusted like every file) and `finish` (`no_reply_needed` or
  `needs_person`). A tool that the grants do not give is refused with a result that says so and an
  audit entry `agent.refused`, and the run goes on; an unknown tool or an input that does not fit
  its schema is answered with the reason and counts as a step.
- **Side effects go through the operations** that a person or an external agent uses (`reply`), so
  the project's policy decides what a reply is: a draft under `review` (state `draft_ready`), a
  queued mail under `direct` (state `sent`, or `resolved` with `resolve`), and the dispatch checks
  of the worker still apply. The idempotency key is derived from the run, so a reply and a note
  are made once however often the run is started: a run that finds its reply ends as it ended then
  without calling the model again.
- **The checks are made again** before every call of the model and before every note and reply
  (`staleReason`): a takeover, a reassignment, junk, a stop, a newer message or an agent that is no
  longer active ends the run as cancelled with the reason, and nothing is written. A note raises the
  revision of the ticket, which the run expects (`current_revision`).
- **How a run ends.** `draft_ready`, `sent`, `resolved`, `nothing_to_do`, `needs_person` (with the
  reason `agent_finished`, `no_action` for an answer without a call, `step_limit`, or the code of a
  task that is not set up, off or without budget), `failed` (a model that the provider does not have,
  an account without credit, or a request the provider refused) or `cancelled`. A limit of the
  provider (429) sends the run back to the queue with the steps it has used; a request that may
  have been accepted (a timeout, a network error, a 503) is not repeated and not sent to another
  provider: the run needs a person and its job goes to review. Every end is audited without the
  content (`agent.run`).
- Every request of a run goes through `runAiTask`, so the fallback of the profile applies to a
  step that was refused, and to no other.
- Not built yet: the desk and the settings for the stops (P2-A3), knowledge search (P5).

In the desk, the ticket shows its assignee and, for a managed agent, the state of the AI work
(`src/components/assignment.tsx`). A person who may assign chooses another assignee there (the
list comes from `GET /tickets/{id}/assignees`), stops the agent on the ticket and lets it
continue, which sends the revision that the page shows. The state is followed while a run is
queued or running. The settings show the stop of a project and the switches of the workspace
(`src/components/agent-controls.tsx`).

### Translation

Machine translation of messages is a derived record (`translation`) next to the source, with its own
profile (`message.translate`; `template.translate` for the standard texts), off by default like every
AI task. A translation never replaces the source, is never a message of its own, never sends and
never resets the response clock.

- **Messages.** `POST /messages/{id}/translations` (tool `messages_request_translation`) queues one
  record per revision and language and a job `translation.run`; asking again returns the record, a
  failed one is queued again as a new job. `GET .../translations` (tool `messages_translations`) lists
  them with state (`queued`, `ready`, `failed`, `stale`), `machine`, the model, the revision of the
  profile and, for a failure, its reason. The job checks again before it asks the model: the message
  may have been corrected (the record is `stale`, no call is made), the ticket may be in junk, the
  person or agent that asked may have lost the right to read it, and a text over 20,000 characters is
  not sent. A limit of the provider is waited for (three tries); every other failure is shown on the
  record and is not repeated by itself, because a request that may have been accepted is not made
  twice. A person removes translations with `POST .../translations/delete`.
- **What is accepted.** The model gets the text as data between markers that cannot be guessed, with
  the languages, and answers with the translation only. The answer must keep code, links, e-mail
  addresses and placeholders literally, and the numbers (amounts, quantities, order numbers; dates
  are left out because they are written by language, and 1.250,50 and 1,250.50 are the same
  number), must be about as long as the text (between a fifth and five times), and must not be cut
  off. Anything else is a failure with its reason (`protected_content_changed`, `implausible_length`,
  `truncated`). Negation, intent and terms are not checked by rule; real providers are qualified with
  fixtures (P7).
- **At once.** `POST /tickets/{id}/translate-draft` translates the text of a reply or a note that is
  being written into the language of the customer (needs the right to write one), and
  `POST /projects/{id}/texts/{key}/translate` suggests a standard text in the other language
  (needs `config.write`). Nothing is stored or sent; both fail alone, with the status of the failure
  (and 422 `translation_unusable` for an answer that fails the checks above), so a provider that does
  not answer blocks this action and no other work. A draft that is clearly in the language already is
  a 409.
- **Display.** The desk shows a translation under its message, labelled as machine translation with
  the model and the profile revision, and a button translates the draft in the composer (with undo);
  the settings suggest a text in the other language. The customer page shows a ready, current
  translation of a message into the language of the page when a person had one made.

### Sources of knowledge

Part P5 of [the completion plan](plans/m4-completion.md). A project can have connections of the
direction `knowledge`, which are only read, by the product and for the project that owns them:

- `github/knowledge`: up to 20 repositories (`owner/name`), an optional API address for GitHub
  Enterprise, a token. Issues and pull requests of those repositories are searched.
- `docs/knowledge`: up to 30 pages by title and HTTPS address, an optional bearer token. Pages are
  read as text (HTML is converted) and searched by paragraph; a page is kept for two minutes.
- `context/knowledge`: an HTTPS endpoint and a key. It is asked `GET endpoint?email=<requester>` for
  what the customer system knows about the requester of the ticket.

A definition needs HTTPS and an allowed host like every connection (`developmentOnly` only on a
development stack), the host is checked again when the source is read, a redirect is not followed
(it would take the key elsewhere), and a test reads one repository, one page or the endpoint.

`GET /tickets/{id}/knowledge?q=` (tool `tickets_knowledge`, needs `ticket.read`) searches the ready
sources of the ticket's project at once and answers with the passages (source, reference, title,
text of at most 800 characters, time of the fetch) and the state of each source (`ok`,
`unavailable` with a code such as `http_401`, `timeout` or `bad_response`, or `not_verified`).
Nothing is made up for a source that does not answer. The query is reduced to words (letters and
digits), so that it cannot carry a qualifier such as `repo:` that would widen a search; a result of a
repository that is not on the connection is dropped. The text is written by others and marked
`untrusted`. Customer data is only asked for the requester of that ticket, and only when the ticket
has a portal record of that address that is verified and not revoked (the record is made when the
portal link for the address is issued; it is not proof that the customer owns the mailbox).

The runner has the tool `search_knowledge` (at most three searches a run, with `ticket.read`), and
the draft button can use the sources (`knowledge: true`): the passages go to the model as data with
their source, and the draft is told to name the source of a fact that it takes from one. A source
that fails leaves the draft without it. The desk shows the search under the ticket.

### Issues of the repositories

Part P5 as well. A project with a `github/knowledge` connection that is ready (or degraded, for
reading) offers issues in the ticket; a project without one has no controls, no routes with an
answer and nothing in the API that mentions a repository (`GET /tickets/{id}/issues` answers an
empty list of repositories).

- **Search and link.** `GET .../issues/search?q=` (tool `tickets_issue_search`) searches each
  repository of the project with words only; `POST .../issues/link` (tool `tickets_link_issue`, needs
  `ticket.note`) reads the issue once and links it. A repository that is not on a connection of the
  project, an issue that does not exist and a repository that does not answer are refused (404, 404,
  502); linking twice is one link; nothing is written to the repository. `POST .../issues/refresh`
  and a pass of the worker every five minutes read the state of the issues of tickets that are not
  resolved or in junk again; one that cannot be read keeps its last known state and says why
  (`refreshError`). Closing an issue changes nothing about the ticket.
- **Drafts.** `POST .../issue-drafts` (tool `tickets_create_issue_draft`, needs `ticket.note`) writes
  a draft for a repository of the project. It starts from what the person writes: nothing of the
  ticket, no note and no customer data is added, so nothing private reaches an issue by itself. The
  draft is changed with the version that was read, and discarded. The desk shows the exact text that
  will be published before the button.
- **Publishing** (`POST /issue-drafts/{id}/publish`, needs `github.publish`, a person, never an agent)
  takes the draft in one step (`draft` or `failed` to `publishing`, with the version), creates the
  issue with the title and the text as written plus a marker in a comment, and records the issue and
  links it to the ticket. A draft is published once: asking again, also at the same time, gives the
  same issue and creates no second one. When GitHub refuses (status 4xx) it did nothing and the draft
  is `failed`, kept for another try. When the outcome is unknown (the request did not complete, or a
  status of 5xx) the draft is `uncertain` and is not published again: `POST .../reconcile` (same right)
  looks for the marker among the newest issues of the repository; found, it is published and linked,
  not found, it is `failed` and can be tried again. A publication that was left `publishing` by a
  crash can be looked up after two minutes.
- Requests to GitHub carry the token in a header, do not follow a redirect, are limited in time and
  check the host again (`src/server/github.ts`). The customer page and its API hold nothing about
  issues.

### The worker on a platform with schedules

The worker of the Docker stack repeats one pass (`src/worker/pass.ts`) without end. A platform that
runs a function for a limited time and calls it from a schedule gets the same pass through
`GET|POST /api/worker/tick`: it works the queue until a pass finds nothing or the time is up (45
seconds, or `?budget=` milliseconds up to 50 seconds), the time being checked between passes. It needs
`CRON_SECRET` (at least 32 characters) in the environment and the header `Authorization: Bearer
<secret>`, which Vercel sends for a cron job when the variable is set; without the variable the route
answers 404, with a wrong or missing header 401. A job is claimed under a lease, so a call that is
cut off leaves its job to the next one. `vercel.json` has the daily call that the free plan allows;
a plan with shorter intervals, or any scheduler that can send the header, calls it more often.

What this does not make equal to Docker: mail is polled and jobs are taken only when the route is
called, so a reply or an acknowledgement waits for the next call (with the daily schedule, up to a
day); the reading of PDF and Office files runs in a closed process that is built from the sources at
run time and does not exist in a function bundle, so those files are reported as not readable there;
the response clock and the refresh of issues run on every call. The Node version of the platform is
at most 24, while the repository asks for 26: a deployment sets its own version. A deployment on such a platform has not been made or qualified yet.

### Stopping agents and outgoing mail

The stops of the plan are at three levels, and only people set them (a token never does, and no
model result lifts one).

- **Workspace** (`PUT /workspace/controls`, owner only; `GET` the same): `stopAutonomous` stops
  every managed agent, `pauseOutgoing` pauses all outgoing mail, for every project. Naming one
  switch leaves the other as it is. They are stored in the row `controls` of `workspace_setting`.
- **Project** (`PUT /projects/{id}/agent-stop` with `{ "stopped": true | false }`, for people who
  may assign tickets): `settings.stopAutonomous`. The pause of outgoing mail of a project stays in
  its configuration (`pauseOutgoing`), where a change goes through the approval of the project.
  `GET /projects/{id}/agent-controls` shows both levels, also to an agent (tool
  `projects_agent_controls`), so that it can see that it is stopped.
- **Ticket** (`POST /tickets/{id}/stop-agent`): sets `agent_paused_at`, the same flag as a
  takeover, and cancels the open runs. `POST /tickets/{id}/resume-agent` lifts it, with the revision that the person read, so that a
  message that came in meanwhile has been read first; the audit entry `agent.resume` names it.

Setting a stop cancels the queued and running runs (reasons `stopped` for the project and the
ticket, `workspace_stopped` for the workspace), and a run that is in flight ends at its next
check. While a stop holds, nothing is queued. Lifting a stop queues nothing by itself, because
what was queued before is out of date: `POST /projects/{id}/resume-agents` queues a run for every
ticket with an assignee that still waits for an answer, at its current revision, for the agents
that may work it (it answers 409 while a stop holds). Every change is audited (the workspace
change is logged, since the audit belongs to a project).

The worker that sends asks again immediately before it hands a message over: a paused workspace
or project stops every dispatch and the test mail of the designs, and an agent's message under
the `direct` policy also needs that neither the project nor the workspace is stopped. A message
that is not sent for that reason waits in review like any other refused dispatch.

## Webhooks

A project can have events delivered to HTTPS endpoints of its own, so that an
automation or an agent does not have to poll. Webhooks are managed through the API
under `integration.manage`, with the same rules as connections:

- `GET /api/v1/projects/{id}/webhooks` lists them with the outcome of the last
  delivery. The signing secret is stored sealed and never returned; the list shows
  `secretSet`.
- `POST .../webhooks` defines one: `name`, `url`, `events` and `secret` (16 to 200
  characters, chosen by the writer). `PUT .../webhooks/{webhookId}` changes it and names
  the version that was read; a new `secret` replaces the old one.
  `POST .../webhooks/{webhookId}/disable` stops it; events already queued for it are
  dropped. Writes accept `?validate=true` and an `idempotencyKey`, and follow the
  approval policy: a person applies, an agent under `review` proposes, a person with
  `config.approve` decides. A proposal keeps the secret sealed.
- The endpoint has to be HTTPS without credentials in the address, and its host name is
  resolved and refused if it points at the machine itself or the link-local range, as
  for connections. It is checked again at every delivery. A development stack accepts
  `developmentOnly: true` for a plain or local endpoint.
- `POST .../webhooks/{webhookId}/ping` queues a test event (type `ping`);
  `GET .../webhooks/{webhookId}/deliveries` lists the attempts with their outcome,
  never the bodies.

Events: `ticket.created`, `message.received` (channel `email` or `portal`),
`ticket.status_changed` (`from`, `to`), `ticket.assigned` (the new and the previous person or
agent, and who assigned, only when the assignee changed), `draft.created` and `change.proposed`. An event
carries identifiers and a few facts (ticket id and number, subject and language for a
new ticket, message id) and never the content of a message or the address of a
customer; the receiver fetches what it needs through the API. Events are queued in the
same transaction as the change that caused them, so none is lost and none is announced
for a change that was rolled back.

A delivery is a `POST` with the event as JSON and these headers: `X-Aidesk-Event`,
`X-Aidesk-Event-Id`, `X-Aidesk-Delivery-Attempt`, `X-Aidesk-Timestamp` (Unix seconds)
and `X-Aidesk-Signature` (`v1=` followed by the hex HMAC-SHA256 of
`<timestamp>.<body>` with the secret). A receiver recomputes the signature over the
exact body, compares it in constant time and refuses a timestamp more than a few
minutes old; `verifyWebhook` in `src/domain/webhooks.ts` does exactly this. Delivery
is at least once: a receiver recognises an event by its id and ignores one it has
seen. A `2xx` answer is success. Anything else, a timeout after 10 seconds or a
refused connection is tried again after 30 seconds, 2 minutes, 10 minutes, 1 hour and
6 hours; after the sixth attempt the job goes to review and the log says `failed`. A
redirect is not followed and counts as a failure. The settings page lists the
webhooks with the last outcome, offers a test event and disabling, and shows no secret.

## AI task profiles

A task of the product that asks a model has a profile per project (C6-A2). The tasks
are `reply.draft`, `note.draft`, `image.read` and `agent.respond` (the runner of a managed
agent, part P2 of [the completion plan](plans/m4-completion.md)). A profile names a connection to a model
provider of the project, a model, a timeout (1 to 300 seconds, 60 by default), a cap
for the output (1 to 16 000 tokens, 4000) and a daily budget in tokens (200 000), and
it says whether the task may run at all (`enabled`, off by default). A task asks a model
through one boundary, `runAiTask` (see "Running a task" below).

- `GET /api/v1/projects/{id}/ai-profiles` (`config.read`, tool `ai_profiles_list`)
  lists the profile of every task. A task without one shows version 0, the defaults
  and no connection or model.
- `PUT .../ai-profiles/{task}` (`config.write`, tool `ai_profiles_set`) sets the
  profile and names the version that was read (`expectedVersion`, 0 for the first
  write). It accepts `?validate=true` and an `idempotencyKey`. The connection has to
  be a connection to a model provider of the same project that is not disabled; the
  answer names the field `connectionId` otherwise, and again when a proposal is
  decided and the connection has been disabled since. A model name has letters, digits
  and `. _ : / -`. Whether the provider knows the model is not checked here: the
  provider refuses an unknown name when a task runs.
- **Switching on is a decision about customer data.** A profile that is on sends ticket
  content to the provider of its connection. Switching a profile on, and pointing a
  profile that is on at another connection, is applied at once only by a person with
  `config.approve`. Anyone else, a person with `config.write` and an agent, also under
  the `direct` policy, makes a proposal (`202`) that a person with `config.approve`
  decides at `/config/changes/{id}/decision`; an agent cannot decide. Other changes
  (the model, the limits, switching off) follow the approval policy like any other
  change: a person applies, an agent proposes under `review`.
- A proposal on a version of the profile that has changed since is superseded and
  never applies. Every change is audited as `ai_profile.set` and kept with its diff.
- The settings page has a section "AI tasks" per project (`src/components/ai-profiles.tsx`)
  with the connection, the model, an optional fallback (connection and model), the limits and the switch, which says that it lets ticket
  content leave the system. It shows the model provider connections of the project, so a
  person without the right to manage connections sees an empty list. The button saves for
  a person who may approve and says "Propose task" for anyone else when the change would
  switch a task on or point it at another provider.

### Running a task

`runAiTask` in `src/server/ai-run.ts` is the one way a task of the product asks a model
(C6-A3). It takes the project, the task, a system text, a prompt and who asks, and answers
with the text, whether the provider cut it at the cap of the profile, the tokens used and the
id of the run, or with one of these codes:

- `ai_not_configured`: the project has no profile for the task, or its connection is not a
  connection of the project to a model provider that is `ready` and has a key, or its own
  address no longer passes the host guard (checked again on every run);
- `ai_disabled`: the profile is off;
- `ai_budget_exceeded`: the day's budget of the task has not enough left for this run;
- `ai_timeout`: the provider did not answer within the timeout of the profile;
- `ai_quota_exhausted`: the account at the provider has no credit or quota left, so a short wait
  does not help (a quota of the day returns at midnight of the provider). It is told by what the provider says, because the status is shared with a
  limit of requests: OpenAI answers 429 with the type `insufficient_quota`, Anthropic answers
  400 with "credit balance is too low" or the type `billing_error`, and Google answers 429
  for a quota of the day (the name of the quota in the answer contains `PerDay`, as for the
  free tier) with the same status as a limit per minute, which stays `ai_rate_limited`.
  The share of the budget is given back;
- `ai_model_unavailable`: the provider does not know the model of the profile (status 404,
  for example a model that was retired; a list of models can still show it). The share of
  the budget is given back. The profile has to name another model;
- `ai_rate_limited`: the provider limits the requests or is busy (status 429, 503 or 529).
  A later call may work. After a 429 the share is given back, after a 503 or 529 it stays
  charged like for any failure whose outcome is not known;
- `ai_provider_error`: any other refusal or failure of the provider (a refused key, a
  malformed request, a server error, a network failure). The provider's own text is not
  kept or shown.

For `ai_quota_exhausted` and `ai_rate_limited` the answer carries the wait that the provider
asked for, when it said: from `Retry-After` (seconds or a date) or OpenAI's `retry-after-ms`,
or from the retry information in the body of Google; a wait of more than a week is
left out. A run gives it as `retryAfterSeconds`, and the REST answer of the draft route
sets the standard header `Retry-After` (the published error body is unchanged). The desk
says "try again in 2 minutes", "in 6 hours" or "in 5 days" when it has the header.

**Tools.** A request can carry the conversation so far (`messages`, with the calls of tools
and what they gave back) and tools (a description and a schema each). A tool has no
`execute`: the model's request for it comes back as `toolCalls` (an id, the name and the
input) and the product runs it, so that every side effect passes the checks of the product
first. The messages and the tools count against the budget before the call, like the files.
Each step of a conversation is one request with one run record; none is repeated by the SDK.

**Budget.** Each profile has a daily budget in tokens, counted per project, task and UTC
day in `ai_budget`. A run holds its share before it calls the provider: the input as
estimated (one token for every three bytes, which is more than Latin text needs) plus the
longest answer the profile allows. The hold is one statement that adds to the day's count
only if the sum stays within the budget, so concurrent runs cannot spend more than the
budget. After the call the hold is replaced by what the provider counted; if it did not
say, the hold stays charged.

**One call, no repeat, one fallback.** The provider is called once, without the retries of
the SDK (`maxRetries: 0`). When the outcome is not known (a timeout, a failure of the network
or of the provider, a status 408 or 5xx) the request may have been accepted and may have cost
something, so the hold stays charged and nothing else is asked. When the provider refused
before it did anything (a status 4xx other than 408) the hold is given back. The answer is
asked for with the output cap of the profile and ends at its timeout.

A profile can name a **fallback**: a connection and a model, both or neither (`fallbackConnectionId`,
`fallbackModel`). It is asked once, with the same request and the same hold, only after a refusal
that did nothing and only for the codes `ai_model_unavailable` (status 404) and `ai_provider_error`
of a refused request (4xx, for example a key the provider no longer accepts). It is not asked after
a limit, a quota, a budget, a timeout or a failure whose outcome is unknown, because the same request
would meet the same limit or may have been accepted. The fallback connection passes the same checks as
the first (of the project, a model provider, `ready`, a key, the host guard again), and when it does
not, the first failure is the answer. Both attempts are rows in `ai_run`: the first with its own
outcome, the second with the connection and the model that answered and `fallback_of` naming the
code that led to it. When the fallback fails too, the failure of the second request is the answer, and
the hold is given back only if that request was refused. The fallback decides where ticket content
goes as well as the first connection does: naming one on a profile that is on is applied only by a
person with `config.approve` when it is another connection than before, and anyone else proposes it.
Another model at the same connection, or taking the fallback away, follows the approval policy.

**Records.** Every run, also one that did not start, is a row in `ai_run`: task, version of
the profile, connection, model, the outcome (`ok` or the code), tokens, duration, who
asked and, for a run that was answered by the fallback, the code that led to it. It holds no prompt, no ticket content and no answer. The provider is reached through
`@ai-sdk/anthropic`, `@ai-sdk/openai` (chat completions, which gateways speak) and
`@ai-sdk/google`; the address of a connection that names its own gets the version path of
the provider added (`/v1` or `/v1beta`).

Not covered here: the prompts, what a task does with the answer, a page that shows the
usage, and a run against a real provider.

### Draft assistance

The reply field and the field for internal notes of the desk have a button "Draft with
AI" (`POST /api/v1/tickets/{id}/draft-assist`, `tickets.assist_draft`). It is not a
tool of MCP: an agent writes its own drafts, and the button is for a person who wants a
first version. The request names the `mode` (`reply` or `note`), an optional
`instruction` for this one draft (up to 1000 characters) and the `current` text of the
field (up to 8000 characters); the answer is `text` and `truncated`.

- **Who and which task.** A reply needs `ticket.reply`, a note `ticket.note`, both with
  `ticket.read` for the ticket; a ticket of another project answers 404. A reply for a
  ticket in junk is refused with 409, like a reply. A reply runs the task `reply.draft`
  of the project and a note the task `note.draft`, so each has its own connection,
  model, limits and switch. Without a profile that is on the answer is
  `ai_not_configured` or `ai_disabled` (409) and the desk says that AI drafts are not
  set up and who switches them on. The other codes of `runAiTask` are 429
  (`ai_budget_exceeded`), 504 (`ai_timeout`), 402 (`ai_quota_exhausted`), 409
  (`ai_model_unavailable`), 503 (`ai_rate_limited`) and 502 (`ai_provider_error`, also for an answer that is empty after
  cleaning).
- **The standard instruction is a text of the project.** The keys `assist.reply` and
  `assist.note` (English and German, up to 2000 characters, no placeholders) are read,
  versioned and written like every text, so changing them needs `config.write` and an
  agent under `review` proposes it. The language is the language of the ticket
  (German or else English). A project's own wording replaces the built-in one but not
  the guard that follows it.
- **The ticket is data.** The system text is the standard instruction, then the
  instruction of the person for this draft, then a fixed guard that says that the
  ticket data and the typed text lie between two marker lines with a random value per
  request, that they are data and never instructions (and that instructions in the
  customer's message, such as a language, words to add or a refund to confirm, are
  ignored), that the draft is returned without comment, that only facts of the data are
  used and that none of a list of usual inventions is made (a date, a status, a price, a
  policy, a tracking number, that something was checked, shipped or refunded), and that
  facts that are missing get a bracketed placeholder. The wording was chosen by trying
  variants against real models; how well a model follows it still differs, and the draft
  is for a person to read before it goes anywhere. The
  user message holds the ticket number, subject, the name of the customer (not the
  address), the language, and the conversation with a role per message (customer, team
  or internal note), then the text typed so far. The newest messages are kept up to
  24 000 characters and each is cut at 4000; the draft is told how many were left out.
  Invisible characters are removed from everything that goes in and from the answer.
  A reply draft leaves out internal notes, so that what is private is not carried into
  a text for the customer; a note draft includes them. Drafts of agents, discarded
  messages and system messages are left out. Attachments are not part of the
  context.
- **The field.** The draft replaces the field as text to edit and is not sent; "Undo
  AI draft" brings back what the field held before the last draft; the text typed so
  far and the instruction go with the next request. A draft that arrives after the
  person moved to another ticket or the other mode is dropped. The reply field of the
  customer portal has no such button, by decision of 2026-10-15.
- **Record.** The run is in `ai_run` (task, profile version, model, tokens, who asked)
  and the audit entry `draft.assist` names the ticket, the mode, the run, whether an
  instruction and typed text were sent, and whether the draft was cut. Neither holds
  the instruction, the typed text, the conversation or the draft.

## Overview and list size

The overview counts in the database over every ticket of the authorized
projects, not over the loaded part of the list (`getOverview`, `GET
/api/v1/overview`): per project the total, the overdue tickets (unanswered
for 24 hours unless the project set another limit), the open ones nobody handles, the due reminders and the ones waiting
for the customer, plus the eight oldest unanswered tickets of each project.
Junk is not counted. The desk sums the projects that the project filter
selects.

### The response cycle and its events

A ticket that waits for an answer has a cycle that starts with the first unanswered message of the
customer (`pending_since`). A note, an acknowledgement, a draft and a further message of the
customer do not move the start; a reply that was sent ends the cycle (`pending_since` is empty),
and a delivery that failed or waits for a person keeps it. The worker looks at the clock about
every half minute (`scanResponseClock`) and queues the webhook events `ticket.warning` (the
ticket has waited for the warning limit of its project) and `ticket.overdue` (for the overdue
limit), each once per cycle: the start of the cycle is stored as the marker (`warned_for`,
`overdue_for`) in the transaction that queues the event, so a restart or a repeated scan sends
nothing twice, a new cycle sends again, and a ticket is locked and read again before an event is
sent, so that no event follows the reply that ended the cycle. A ticket found past both limits gets
both events. An event carries the ticket id and number, the start of the cycle and the limit in
hours. The marker is set also when no webhook is subscribed: an event that nobody listened to is
not sent later when someone subscribes.

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

## Production image

`docker build --target production .` makes the image that runs: the web server, the worker
and the migrations are one image with three commands, and the development target stays as
it was. The build stage installs the dependencies, builds the application and removes the
tools of development; the image is copied from it.

- **Web server:** `node web/server.js` (the standalone build of Next.js, with the static
  files beside it), on port 3000 with a health check on `/api/health/ready`.
- **Worker:** `node_modules/.bin/tsx src/worker/index.ts`. It needs the source and the
  dependencies, because it builds the reader of documents with esbuild when it starts.
- **Migrations:** `node_modules/.bin/tsx scripts/migrate.ts`.
- **Smoke check:** `node_modules/.bin/tsx scripts/smoke.ts` runs the reader of documents in
  its closed process and needs neither a database nor a network.

The base is a full Debian image (`node:26-bookworm-slim`) because the reader runs in a
process of Node's permission model that is started through `/bin/sh`; a distroless image has
no shell. The process runs as the user `node`, the application files belong to root and
cannot be written by it, and no credential is in the image: the source is copied without
`.env*` (`.dockerignore`), and the configuration comes from the environment when a container
starts. The standalone server reads `KEEP_ALIVE_TIMEOUT` (milliseconds) for the time it keeps
an idle connection open, which has to be longer than that of a proxy in front of it.

Checked on 2026-10-15: the CI job "Production image" builds the image, runs the smoke check
and checks that the process is not root and cannot write `/app`. By hand, against the
services of the development stack: the web server became healthy and answered the login
page, the API definition, the agent guide and a static file; the migration command ended
without a change; the worker started and refused the development connections of that
database (`development_connection_not_allowed`), which is the behaviour of a production
process. A Compose file for it follows. Not done: TLS and a proxy in front, measured start
and recovery times, backup and restore, and Vercel.

### Compose

`compose.production.yaml` runs the image with a database and a storage of its own or yours.
It holds no secret: every value comes from the environment, from a `.env.production` next
to it (mode 0600, passed with `--env-file`; `.env.example` lists most of the names) or from your
deployment tool.

    docker compose --env-file .env.production --profile bundled -f compose.production.yaml up -d --build

- **Required:** `APP_URL`, `BETTER_AUTH_SECRET` (32 characters or more), `ENCRYPTION_KEY`
  (64 hexadecimal characters), `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `POSTGRES_PASSWORD`
  unless `DATABASE_URL` is given. `OWNER_CLAIM_TOKEN` (32 characters or more) is needed
  once, to claim the first owner at `/setup`; remove it afterwards. An empty value counts as
  none.
- **Database connections:** the web server keeps up to ten connections (`DATABASE_POOL_MAX`) with
  prepared statements. On a platform that starts many short-lived instances behind a pooler,
  ten for each instance exhaust the pooler (a session pool of 15 connections at Supabase gave
  `EMAXCONNSESSION` with a few instances and two test workers). Use the transaction mode of the
  pooler with `DATABASE_POOL_MAX=1` and `DATABASE_PREPARE=false`, which the pooler needs because it
  does not keep prepared statements; the product uses no feature that needs a session (no
  advisory lock, no `LISTEN`, no setting that lasts beyond a transaction).
- **Services:** `migrate` applies the migrations and creates the bucket of the storage (nothing
  else did; without the bucket the web server reports itself not ready) and ends; `app`
  (the web server, on `127.0.0.1:3000`, `APP_BIND` and `APP_PORT` change that) and `worker`
  start after it. The profile `bundled` adds PostgreSQL and the Silo storage with volumes;
  leave it off and give `DATABASE_URL` and `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` to use
  your own.
- **Containers:** the root file system of `migrate`, `app` and `worker` is read-only, with
  `/tmp` as a temporary file system (the worker builds the reader of documents there), and
  nothing but the web server is published. TLS is for a proxy in front; the standalone
  server's `KEEP_ALIVE_TIMEOUT` is 65 000 ms here, longer than the idle time of common
  proxies.
- **Proxy and TLS:** the profile `proxy` (`COMPOSE_PROFILES=bundled,proxy`) adds Caddy in front of the web
  server, with the configuration in `config/caddy/Caddyfile.production`. `SITE_ADDRESS` is the host name that the
  product is reached at; for a public name Caddy gets and renews a certificate from Let's Encrypt by itself, and
  ports 80 and 443 (TCP, and 443 for HTTP/3) have to reach it. It redirects HTTP to HTTPS, sends
  `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options`, sends no
  `Server` header, refuses a body of more than 40 MB (the largest that a route reads is the reply of a customer
  with files, 31 MB) and does not buffer the streaming of MCP. A client address in `X-Forwarded-For` is replaced
  by the address of the connection (the default of Caddy for a client that is not a declared proxy; the
  check does not test it), because the limits of sign-ins count by it and no proxy in front of this
  one is declared; behind a load balancer of your own that has to be changed. For a check on one machine,
  `SITE_ADDRESS=localhost` with `TLS_DIRECTIVE="tls internal"` gets a certificate from Caddy's own CA.
  `PROXY_HTTP_PORT` and `PROXY_HTTPS_PORT` change the ports, `CADDY_GLOBAL_OPTIONS` takes lines such as
  `email ops@example.org`. The image is pinned by digest; the certificates are in the volume `caddy-data`,
  which a backup of the database and the objects does not contain (a lost volume means new certificates, and
  Let's Encrypt limits those per name and week).

Checked on 2026-10-15 from a clean state with generated throwaway values: the project came up
with `migrate` ending successfully, `app` healthy and `worker` running; `/api/health/ready`
answered ready, `/setup` and the API definition answered, an unauthenticated call was
refused, a wrong owner token was refused and the right one started a claim; the smoke check
passed inside the worker with its read-only root; data in the database survived stopping and
starting the stack. The first run showed that a clean installation could not become ready,
because only the development seed created the bucket; `scripts/migrate.ts` does it now.

#### Backup and restore

`sh scripts/production-backup.sh backup <directory>` writes `database.dump` (PostgreSQL
custom format, from the bundled database; for a database of your own use its own backup
tool), a copy of the objects (`objects-copy/`, a file per key and `manifest.jsonl` with size,
type and SHA-256, made through the S3 API, so any storage works) and `SHA256SUMS`. The
database is dumped first and the objects after it: an object is stored before the row that
names it, so a copy of the objects that is newer than the dump holds objects that no row names
yet, which the sweep removes, while the other order could leave a row without its object.
`sh scripts/production-backup.sh restore <directory>` checks the sums, stops the web server
and the worker, restores the dump (`pg_restore --clean --if-exists`), imports the objects only
if every file matches the manifest (a damaged copy changes nothing), and starts the services
again. The directory has to be on the machine that runs Docker (on Docker Desktop or Colima, in
a folder that the VM shares). Run the sweep afterwards, as the script prints.

`ENV_FILE=<file> sh scripts/check-production.sh` qualifies the setup on a machine and the CI
job "Production image" runs it with throwaway values: it starts the project `aidesk-check`
from a clean state, puts a ticket with a message and an attachment and three objects into it
(one of them named by no row), restarts the services, makes a backup, deletes the volumes,
starts again, restores, and checks that the rows and every object (by SHA-256 and type) are
back and that the sweep finds nothing that a row names. Measured on 2026-10-15 on an Apple
silicon laptop with the image built, bundled PostgreSQL and storage and almost no data: ready
after 7 s from a clean state, 1 s after a restart of the web server and the worker, 4 s from
the start of a restore to ready, a backup in under a second. These are measurements of the
mechanics on this machine and not recovery targets: the time of a restore grows with the
data. With the proxy on and `BULK_TICKETS=20000 BULK_OBJECTS=3000` (20 001 tickets, 60 001 messages,
70 MB in the database, 3 003 objects of 50 KB) the same run on 2026-10-17 took 12 s from a clean state to
ready, a backup of 10 s, and 14 s from the start of a restore to ready; the counts after the restore were the
counts before it. That is 150 MB of objects and a database that is small for a real deployment, so it shows
that the time grows with the data and by how much in this case, and it is not a target for a deployment of
real size. The check of the proxy in the same run: TLS with the certificate of its own CA (a client without
that CA is refused), HTTP answers 308, the four headers and no `Server`, 401 for an unauthenticated call
through the proxy, and a body of 45 MB refused with 413 where one of 30 MB reaches the application (the limit
works while the body is read, so it is tested on the sign-in, which reads it before it answers). A container that is killed by hand (`docker kill`) stays down under the policy
`unless-stopped`, as it does for any manual stop; one that crashes is started again.

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
deletes them afterwards, with the objects they stored (before this, a development bucket
held 27 000 objects of deleted test projects, 4.9 GB, which the sweep removed), so the
development desk data stays unchanged. CI runs
them in the Browser tests job against the same Compose stack. The app and the worker
load `scripts/dev-keep-alive.cjs` through `NODE_OPTIONS`: Node closes an idle connection
after about six seconds, and the request context of Playwright, which keeps connections
open, failed with `socket hang up` (ECONNRESET) when it sent on one in that instant
(14 of 20 requests after a pause of six seconds in a measurement); the stack now keeps
them open for two minutes.
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

Done in code for
