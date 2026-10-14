# Initiative plan: aidesk initial product

Epic: [#1](https://github.com/metaneutrons/aidesk/issues/1).
Decision state: agreed product direction; implementation tracking authorized
on 2026-10-11. Configurable defaults are design decisions, not implemented
settings or achieved service levels.
Repository location: `docs/plans/initial-product.md`.
This versioned plan owns requirements; linked issues own execution and evidence.
The epic and milestone links identify the actual authorized tracking records.
No application implementation is accepted.

## Outcome and boundaries

aidesk provides a simple shared support inbox for solo developers and small teams
operating multiple projects. The initial target is up to ten projects, 1,000
tickets per month and one to three operators. Project-specific email identities,
portal addresses, permissions and automation rules are first-class concepts.

Measured baseline before tracking documentation on 2026-10-11: the `metaneutrons/aidesk` checkout and remote
contained no commits or application files. Git read access works. Node 24.19.0 and
pnpm 11.25.0 are available. pnpm registry requests and writable store/cache
configuration were verified. No application build, SSO flow or deployment has
been qualified.

Included: hosted email providers and IMAP/SMTP, acknowledgements, ticket portals
through personal email links, operator OIDC and SAML login, project/action
permissions, authenticated REST and HTTPS MCP, autonomous AI under project rules,
GitHub/documentation/customer-API knowledge, and Vercel plus Docker deployments.
Include an extensible channel model reserving WhatsApp, Telegram and Signal for
inbound/outbound adapters. The initial messenger implementation set is undecided;
architecture readiness does not mean any messenger integration is already built.
The MVP includes English/German operator and customer UI, and AI translation for
human-readable communication across implemented channels. UI localization and
message translation are independent capabilities.

Deferred: an AI chat interface inside the operator UI, extensive SLA/reporting
features and cluster orchestration. Customers
retain the agreed ticket-link flow; operator SSO does not replace it.

## Design and decisions

Interaction design companion: [UX concept](../design/ux.md).
It specifies the desk, composing, original-mail preview, junk/intake, AI takeover,
project setup, email design and customer portal. It remains unimplemented and
requires prototype/usability qualification before quality claims.

Use one TypeScript domain core behind UI, REST and MCP. Use Next.js/React,
Tailwind/Base UI, PostgreSQL/Drizzle, private object storage, a persistent outbox
and a separable email worker. Better Auth with its SSO plugin is the proposed
OIDC/SAML authentication layer. Authorization follows Vellum's central
principal/scope/permission model and remains owned by aidesk.

Use a provider-neutral execution boundary, proposed AI SDK Core with explicit
direct provider instances/registry (OpenAI, Anthropic, Google; others only after
capability qualification). Gateway use is optional. Persist separate connections,
versioned task profiles and agent/service identities. Tasks include junk,
extraction, reply drafting and bounded tool-using response work. Workspace
defaults and project/agent profile assignments choose approved models/context/
limits/fallbacks, including communication translation; model choice never expands
tool/project rights. Validate output
schemas and semantics with representative fixtures; retain job configuration
snapshots, provider/model usage and known/unknown cost explicitly. Secrets stay
server-side encrypted and custom endpoints need controlled destinations.
Managed jobs and external MCP runners share the same authorization core; external
model runtimes remain external. Bounded durable steps support Vercel and Docker.
Retries/fallback model calls must not replay already committed tool/send actions.
Metadata checked: ai 7.0.137 and direct-provider packages 4.0.x; no integration
build or live model test has been performed.

Vellum reference: `metaneutrons/Vellum` at
`a8a6b54845972f49c3776446b7272ea9a510d1bc`. Its Aurora tokens, permission registry,
revocable identities, scoped access and audit patterns inform the design. Its
existing Entra OIDC flow does not establish SAML readiness. Code or asset reuse
requires preservation and resolution of the applicable provenance/license terms.

Repository standard: `metaneutrons/claude-skills/gitrepo` at
`160504750456c32ec87821ddd4917e91960f09b8`. Use pnpm without Corepack,
`packageManager` pinning, TypeScript `~6.0`, strict derived TypeScript configs,
type-aware strict/stylistic ESLint with zero warnings, Lefthook, Conventional
Commits, coverage gates, SHA-pinned Actions and English repository content.
CI runs exclusively on Node 26, as explicitly requested by the user. This is a
recorded exception to gitrepo's Node 24/26 matrix. Next.js-specific config
differences need a recorded rationale without relaxing strictness.

The currently proposed framework releases are Next.js 16.4.0, React 19.3.0,
Tailwind 4.3.3, Base UI 1.9.0 and Better Auth/SSO 1.7.7. Recheck versions at
implementation and resolve their integration through real builds. TypeScript
7.0.2 is newer but conflicts with the specified lint peer range and requires
investigation of Next.js's compiler API dependency; do not bypass checks.

Use one capability registry with source-linked declarations for UI, REST and
MCP, a rationale for every surface difference, and a test detecting changes in
either direction. State its full-build/conditional-compilation limitation.

Vercel and Docker expose the same business APIs. Platform-specific scheduling,
object storage and authentication configuration belong behind explicit boundaries.
Authentication proves identity; access is granted separately per project and
action. Customer portal grants never include operator notes or other tickets.

Instance configuration is supplied through validated deployment environment
variables/secrets: database connection, canonical application URL, object storage
and authentication/encryption secrets. Workspace/project settings are persisted
in PostgreSQL and managed through the authorized UI, REST or MCP. Daily support
configuration should not require editing deployment files.

PostgreSQL owns tickets, messages, contacts, identities, permissions, settings,
audit events, sync cursors and outbox state. Private S3-compatible storage owns
attachments and originals retained under a configurable policy; incoming originals
are saved for preview/extraction review. PostgreSQL stores object metadata.
Vercel uses external persistent services; Docker supports local persistent
PostgreSQL volumes and local or external object storage. The local Docker object
store is PGSTY Silo (`pgsty/silo`), an S3-compatible MinIO fork under AGPL-3.0,
run as a separate service and used only through the S3 API. Process-local state is
not the source of truth for durable data.

Deployment secrets stay outside database configuration. User-managed integration
secrets are encrypted server-side using a key held outside the database. Access
tokens are stored as hashes where verification does not require recoverable
material. Backups must restore the database, objects and required key material;
the operational contract below defines recovery, rotation and retention.
The first owner needs a controlled one-time bootstrap; SSO auto-provisioning
must not silently grant ownership.

Each project owns versioned email designs and templates for replies,
acknowledgements and notifications. Configure logo, colors, typography, spacing,
header/footer and signature with preview and test sends. React Email is the
proposed renderer, shared by SMTP and hosted-provider transports. Validate the
actual output in Gmail, Apple Mail and Outlook, including mobile and dark mode;
browser previews alone are not client qualification. Public logo assets or CID
embedding must not expose private attachments.

Store semantic message content as Markdown independently from its presentation:
CommonMark with selected GFM extensions and no raw HTML. UI, REST and MCP share
paragraphs, lists, links, tables and code; image/attachment metadata remains separate.
Chat renders this content alone; outbound mail wraps it in the selected project
template and emits HTML plus corresponding plain text. The server chooses the
authorized project identity and design. Persist the submitted HTML/text, template
version and sender snapshot for historical traceability.

Inbound extraction removes detected previous-thread quotations, signatures and
template fragments without summarizing customer content. Preserve inline replies
between quoted passages and meaningful formatting, links, code and attachments.
Sanitize displayed HTML and do not automatically fetch remote tracking images.
Keep the received original private under a configurable retention policy, expose
uncertain extraction and support review/correction. An ambiguous heuristic must
not irreversibly discard a customer's statement.

Each inbound message exposes an authorized operator action to view the original
mail in an overlay or side panel, preserving its layout, signatures and history.
Plain-text messages have a text fallback. Sanitize and sandbox the preview without
script execution, forms or application-origin access; block remote resources by
default and serve authorized CID images privately. Qualify focus and keyboard
behavior as well as project/message access boundaries.

Run AI junk classification for spam/advertising before content extraction, with
project configuration independent of AI extraction. Persist the original, parse
MIME and resolve project/candidate ticket context before classification; create
or update a support conversation only for admitted mail. Record structured
category/reason/method/model provenance. Trusted spam signals and explicit sender
rules can support classification; claimed identity/thread references alone are
not proof of trust. Uncertain cases remain visible for review. A classifier
failure must not discard mail or allow unchecked automatic replies.

Junk goes into a project-scoped aidesk area without creating a support ticket,
posting into an existing conversation, acknowledging or triggering AI replies.
The existing ticket's status is unaffected. For IMAP, also move the original to
the configured/discovered server Junk folder after durable recording; failures
remain visible and retry independently without duplicating ingestion. Webhook
input uses aidesk junk storage without assuming a remote folder. Authorized
UI/REST/MCP can inspect originals and restore false positives into the remaining
pipeline idempotently, including an IMAP move back to the configured ingress
folder. Preserve decision audit, private originals and configurable retention;
classification does not immediately delete mail.

An optional project-configurable AI extraction task, disabled by default, uses the
received mail and available same-ticket context to identify new customer content
as Markdown. This is an automatic inbound pipeline stage: when enabled, every
admitted incoming email passes through it, from both webhook/Worker and IMAP adapters.
Persist the original, parse MIME, resolve project/ticket and normalize before
contextual AI extraction; persist final Markdown before downstream automation
consumes the message. Authorized UI/REST/MCP manage project configuration and
inspect pipeline status; there is no per-message extraction action or mandatory
manual approval. The default parser works without AI. Extract statements without summarization or invention;
treat mail/history as untrusted data rather than instructions, and do not perform
reply/closure actions as part of extraction. Store source/method/model/version
provenance, retain originals and parser-based content for later comparison.
Failure uses the parser-based result with explicit fallback status. Durable jobs,
bounded retries, deduplication and per-ticket ordering preserve mail and context
across restarts. Stale jobs cannot replace newer manual corrections; context
limits must remain explicit.

## Languages and AI translation

### Deterministic UI localization

English and German are complete MVP locales for the operator app, customer
portal and human-readable system messages: labels, forms, validation, empty/error
states, accessible names, email acknowledgements and notifications. Use reviewed
versioned catalogs with ICU messages/plurals and locale-aware Intl date/time/
number formatting. AI can prepare catalog/template translations during authoring;
review and publish them as deterministic versions. Do not depend on a runtime
LLM for ordinary UI rendering or security/error copy.

Proposed Next.js i18n layer: next-intl. Registry metadata on 2026-10-11 reports
4.14.9 with Next.js 16/React 19 peer ranges; this is not an integration build.
Compatibility with the actual Next.js/SSO/MCP routes needs real qualification.
OAuth/MCP callbacks, webhooks and machine API paths remain stable and unlocalized.
API enums, status codes and capability IDs do not change with display language.
Repository prose remains English under gitrepo; German catalog strings and
multilingual message fixtures are the explicit user-required localization
exception, not a change to commit/PR/documentation language.

Persist operator UI locale as a user preference; use browser negotiation only
when no preference exists, with English fallback. Portal UI uses the customer's
explicit choice, then supported browser locale/project default. Portal locale is
not the same as the customer's communication language. Changing locale preserves
ticket, draft, filter, identity and authorization context; locale cannot broaden
portal grants or project discovery. Format elapsed times without changing the
underlying receipt/cycle timestamps. Mark message language and direction correctly
and isolate mixed-direction content without requiring an RTL operator UI in v1.

### Communication languages and content records

Projects configure a default communication language, enabled target languages,
translation policy and glossary/terminology. Verified project-scoped participants
can choose a communication language; an explicit ticket choice wins. Otherwise
use the requester preference, sufficiently reliable detected language, then the
project fallback. Ambiguous/unsupported detection is visible rather than guessed.
Operator UI language never silently changes the customer's outgoing language.
A multi-participant public conversation uses one explicit conversation language;
show recipient/language mismatches rather than silently creating different copies
or exposing other participants' preferences. A later locale change does not rewrite
historical content or sent mail.

Keep the extracted source-language Markdown and original mail separately from
derived translations. Records identify source revision/hash/language, target
language, task profile/model/prompt/glossary versions, method, status and edits.
Translation does not overwrite source content, become an extra customer message,
admit junk, or reset response age. A manual edit invalidates derived translations
of the old revision. Apply access checks to both originals and translations;
private notes never become public through localization. Export and retention/
deletion cover the same source and derived content.

For admitted customer input, run optional extraction first, persist canonical
Markdown, then queue translation automatically when the configured operator
reading language differs. Do not make it a required per-message action. Junk
and uncertain intake retain their earlier processing boundaries. Cache durable
translations by authorized project/message/revision, target language and profile/
glossary version; missing translations are queued, pending/failed results are
visible and the source stays usable. Multiple operators can read the same source
in their own language without changing ticket identity or customer reply language.

Public replies can be composed in the operator's language or by an agent, then
translated to the explicit customer target before channel rendering. The send
flow snapshots source draft, final recipient-language Markdown, subject, locale,
template version and rendered HTML/text or channel payload. Translation alone is
not sending; draft/review/autonomous modes and fresh dispatch permissions still
apply. Manual mode shows the exact outgoing translation and allows correction;
autonomous mode uses only approved translation/profile/project policies. If
translation fails or is stale, do not silently send the source in another
language: retain the draft and require recovery or an explicit authorized choice.

The contract covers email subjects and bodies, portal replies, implemented
messenger text/captions and authorized internal-note reading. Email chrome,
signatures, notifications and automatic acknowledgements use reviewed localized
project templates with an explicit fallback, avoiding an LLM dependency for every
acknowledgement. A recipient without a supported template sees the configured
fallback language, not an unrecorded guessed translation. Attachments, screenshots
and binary/audio content are not automatically OCR/transcribed in this scope;
preserve them as attachments. The message-language boundary applies to future
messenger adapters without claiming those integrations are already implemented.

### Translation task profiles and qualification

Add independently configurable `message.translate` and `template.translate`
profiles to the provider-neutral model layer. They share server-side budgets,
timeouts, approved provider/context restrictions and durable retries without
tool/send rights. UI/REST/MCP configure language policy, inspect status and obtain
authorized source/translated content through the same core. Translation settings
and records are persisted in PostgreSQL, with secrets remaining encrypted.

Translate meaning faithfully, without summarization, invented promises or tone
rewriting. Preserve Markdown structure and protect code, URLs, opaque identifiers,
placeholders, numbers, currencies and names against semantic changes. Extract
text nodes and reconstruct validated Markdown; model-generated unsafe markup or
altered links are rejected. Treat the source/context as untrusted data, not
instructions. Glossaries constrain project names/terms without expanding context.
Use source text as the authority when understanding or drafting replies; inspect
the actual outgoing language before manual send. Prevent round-trip translation
of a translation and duplicate jobs from rendering or retries.

Qualify English/German UI completely and real message translation across them,
plus a representative third communication language to demonstrate extensibility.
Additional project-enabled language pairs require representative fixtures and
explicit capability qualification, not a claim of perfect worldwide translation.
Evaluate intent, negation, complaints, terminology, quantities, inline code and
injection attempts; schema validity alone does not prove translation quality.
Provider failure/budget limits leave source communication accessible and never
bypass review, current permissions or outgoing-delivery controls.

Use Mailpit as the development SMTP capture service, available through a Compose
development profile or standalone binary for cloud development. Its UI/API inspect
HTML, plain text, headers and attachments; automated tests assert project identity,
ticket links, content and delivery count and exercise simulated SMTP failures.
Development must not enable external relay/forwarding. A Vercel staging deployment
needs an externally hosted, protected test-mail service. Mailpit does not provide
IMAP or emulate provider APIs, and does not replace real delivery/client tests.
The component has not yet been installed or started.

Unresolved integration inputs: actual domains, email accounts/providers, identity
providers, allowed GitHub repositories, documentation sources and customer API
contracts. Distribution channels and the corresponding lean/hardened release
profile remain to be established before release configuration. Issue creation
and the associated plan are authorized; application releases, protection changes
and paid integration provisioning are separate actions.

GitHub issue integration supplements read-only knowledge retrieval. A configured
project repository enables issue search/linking and an operator-only linked issue
view with title, number, status and source URL. Support many tickets per issue.
An explicit create-issue flow prepares a reviewable title/Markdown draft; exclude
internal notes, customer identity and private attachments by default. Publication
needs separate project action permissions and repository write capability, with
the same domain operation in UI/REST/MCP. This integration contract does not
grant autonomous AI repository write access. Prefer a
repository-scoped GitHub App; authenticate webhook updates and reconcile missed
events. Issue closure does not automatically close tickets, and private issue
content stays out of customer portals unless explicitly shared.

Tickets have one accountable assignee, either a project-eligible person or named
AI service identity. Assignment requires explicit action rights and never expands
the recipient's scope. AI assignment queues a durable reply task with draft/review
or authorized autonomous-send mode. Manual takeover/reassignment invalidates
older tasks; separate intake extraction/classification from support assignment.

The shared inbox offers Oldest unanswered and Overdue. Response age starts at
the first still-unanswered customer message; subsequent customer mail, notes,
acknowledgements, assignment and AI drafts do not reset it. A substantive public
reply with confirmed transport acceptance completes the cycle; unsent/failed
responses do not, and subsequent delivery failure restores the obligation.
Show total ticket age separately. Project thresholds warn/escalate with internal
alerts or configured eligible-person handoff, equally for human and AI assignees.
Begin with elapsed time, deferring business-hour/SLA contract complexity. Durable
idempotent scheduling catches up after restarts and rechecks the current reply
cycle/revision before action. Snooze cannot erase an unanswered obligation.

## Operational behavior and starting defaults

These decisions consolidate the behavior review into this acceptance authority.
Numerical values are configurable starting defaults. Actual accounts/domains and
recovery infrastructure remain qualification inputs, not assumed readiness.

### Lifecycle and participants

Keep workflow, intake processing, delivery and response obligation independent.
Workflow states are Open, Waiting for customer and Resolved; assignment and snooze
are separate. Admitted customer input opens an obligation from trusted server/
edge receipt time, not sender Date or the end of AI processing. A substantive
accepted reply normally moves to Waiting for customer, with an explicit Keep open
option. Send and resolve resolves after acceptance; resolve without reply needs
an audited reason. Failed/uncertain sends preserve draft and obligation. Bounces
restore the affected cycle without overwriting newer cycles. Replies record the
customer revision covered; new input invalidates stale agent sends.

Customer input reopens Waiting tickets. Reopen Resolved tickets within 30 days;
later input creates a linked follow-up with its own participants/grants. Starting
elapsed-time thresholds: warning at 4 hours, escalation at 24 hours, further
escalation at 48 hours. Configure eligible fallback people per project. Snooze
leaves overdue obligations discoverable.

Start with requester-only portal access. Explicit verified participants have
project-scoped identities/endpoints and distinct revocable ticket grants. Adding
a notification recipient and granting history access are separate; CC/BCC alone
grants neither. Replies show/persist exact authorized recipients without silently
adopting a changed reply-all list. Public views never reveal hidden recipients.

Thread matching checks receiving project/account, supported opaque/thread
references and participant trust. Claimed From, Message-ID, name or customer ID
alone is insufficient. Suspicious senders/ambiguous forwards remain reviewable
without history leakage. Customer API mapping needs a trusted project assertion,
verified portal flow or audited operator decision. Cross-channel identity linking
is explicit and project-scoped.

### Durable jobs and external actions

Persist raw objects/checksums before accepting ingress; reconcile orphan uploads.
Commit domain changes and required jobs/outbox entries in one PostgreSQL
transaction. Authenticate/bound webhook input before parsing or model work.
Namespaced event/action IDs and fingerprints deduplicate without trusting global
email IDs. Jobs use Queued, Running, Retry scheduled, Succeeded and Needs
intervention; leases/fencing and compare-and-set revisions prevent stale results.
Keep slow network calls outside long transactions. Ticket ordering protects
new input, drafts, corrections, takeover and permission revocation.

Docker workers and bounded Vercel execution share job storage/semantics;
schedulers only wake durable work. Transient retries start at at most six attempts
within 24 hours with jitter and Retry-After; permanent credential/validation/
recipient failures require intervention. SDK/worker retries share one budget.
Authorized/audited resume cannot replay stale work blindly.

Record attempts before external sends. After a timeout/crash with uncertain
acceptance, reconcile provider evidence or require intervention, without blind
retry/provider switching. Database deduplication is not exactly-once external
delivery. External issue creation follows the same ambiguity rule.

### AI policies and stop controls

Project support modes: Manual, Draft and Autonomous; Draft is the starting
default. Autonomous send/close needs project policy and agent rights. Intake
junk/extraction switches remain independent. Models cannot grant themselves
permissions. Snapshots reproduce model/prompt choices, while current permissions,
destination, takeover, budget and stop policy win at dispatch.

Provide Stop autonomous actions at workspace/project/ticket scope and separate
Pause outgoing delivery. Check immediately before side effects; accepted actions
cannot be recalled. Resume preserves freshness/audit rather than blindly replaying
pending sends. Start agents with eight model/tool steps and one public response
per admitted customer revision. Reserve budgets before calls and record usage.
Known-cost hard caps stop work; unknown pricing is labeled and uses token/call
limits. Approved fallbacks preserve project/context boundaries. Schema checks and
semantic evaluations qualify profiles; model confidence is not a spam guarantee.

### Retention, recovery and health

Starting retention: tickets/originals/attachments 24 months after resolution,
junk/logs 30 days, minimal audit metadata 12 months. Active tickets do not expire
under resolved-ticket retention. Destructive shortening needs preview/count and
grace period. Export readable/structured content and authorized objects without
secrets. Delete across database, objects, indexes, grants and jobs; keep minimal
audit metadata and a restore deletion ledger. External records are not deleted
silently. Settings are project-configurable.

Backup retention target is 30 days. Recovery targets are RPO 15 minutes/RTO
4 hours, conditional on provisioned PITR/WAL, object protection and measured
restoration; daily dumps alone do not satisfy them. Versioned keys have separate
protected recoverable custody. Rotate using key IDs/re-encryption and preserve
required old keys. Restore in isolation with outbound/AI paused, replay deletions
and verify objects/data/permissions before activation.

Compact authorized Health shows adapters, ingress/job age, review cases,
failed/uncertain sends, AI budget stops and overdue obligations. Starting backlog
attention threshold is 5 minutes, urgent at 15 minutes or sustained authentication
failure; uncertain sends need immediate inspection. Deduplicate incidents across
retries; show owner/project/timestamps/next safe action. Use correlation IDs and
structured metadata; secrets, raw mail and full prompts are not ordinary logs.
Separate liveness from readiness.

### Setup and daily operation

First-owner setup is a controlled one-time claim. Creators receive an explicit
authorized project membership; other users require a grant. SSO issuer/subject
establishes identity; role/JIT mappings are separate and revocation applies
without waiting for login. Qualify an audited protected owner recovery path with
MFA for IdP outage, without a permanent global API-admin fallback token.

Use scoped expiring service credentials for runners; real protocol-compatible
OAuth discovery, PKCE/resource binding and minimal scopes for interactive MCP.
Select/test actual MCP clients in M1. Connections distinguish Draft, Verification
needed, Ready and Degraded. Inbound/outbound tests and reply round-trips are
independent; saved settings are not verified readiness. DNS is an explicit
external prerequisite. Customer APIs have reviewed read-only schemas, endpoints,
bounds and trusted identity mapping; custom endpoints cannot forward credentials
or access arbitrary internal hosts.

Overview is home; Needs attention defaults to oldest unanswered first. Counts/
rows share authorized query semantics. Composer shows project, exact recipients,
public vs internal mode and send state. Drafts survive filtering/failure; stale
edits return visible conflicts while preserving work, without silent overwrites.
Settings lead with presets/effective defaults. Observe critical tasks without
wrong-project sends or public internal notes, including keyboard completion and
failed-send/conflict recovery, before claiming UX quality.

Merge/split and reusable Markdown snippets remain candidates for later priority;
they are not mandatory v1 deliveries in this initiative.

## Delivery and acceptance

### Delivery order

M1 establishes REST/MCP entry points together with identity, policy and data
contracts. M2 supplies durable ticket/mail operations. M3 UI work and M4 AI/
knowledge execution then develop together against these contracts; design and
prototyping can start earlier. Qualify their shared workflows at capability level,
without requiring either whole milestone to close before the other. M5 exercises
the complete product on both deployments. Issues are ordinary linked issues;
native GitHub Milestones, labels and Projects are optional, not acceptance gates.

Generalize the adapter contracts to channel, connected project account/identity,
independent inbound/outbound handlers, namespaced conversation/message references
and declared capabilities. Retain the mandatory email pairings. Normalize content
to the shared Markdown/message model and use channel-specific rendering/limits;
MIME/HTML preview remains mail-specific. Default replies stay on the original
channel/chat. Cross-channel routing needs a verified destination and explicit
policy/action; do not merge identities by display name. Respect platform-specific
media, receipt and response/template constraints through the same UI/API/MCP core.
Reserve Telegram Bot API, WhatsApp Business Cloud API and a possible signal-cli
connector; select and qualify the actual messenger subset separately. A persistent
Signal connector runs outside Vercel functions and retains private account/key
state securely. No messenger credentials, installation or live tests exist.

Cloudflare is a required first-class inbound adapter in v1 alongside IMAP.
Outbound mail uses SMTP (in operation: SMTP2GO). Persist and expose separate
incoming/outgoing handler configuration, credentials, identity verification,
health and tests. Qualify the pairings Cloudflare/SMTP and IMAP/SMTP with real
domain/sender prerequisites. The Cloudflare Email Sending adapter stays
available but is not qualified for v1: without the Workers Paid plan it
delivers only to verified destination addresses of the account. Map project ingress routes to authorized
outgoing identities/defaults, without coupling providers. All replies and
acknowledgements use the selected outbound handler; thread across adapters with
mail headers and aidesk identity. Junk capabilities follow inbound, while size/
quota/delivery behavior follows outbound. Preserve auditable handler references
for pending sends; uncertain acceptance must not trigger silent cross-provider
resending. Changing one handler must not silently alter the other.

### M1: Foundation, identity and authorization

Milestone issue: [M1 #2](https://github.com/metaneutrons/aidesk/issues/2).
Dependencies: none; actual IdP configuration is required for SSO qualification.
Outcome: a buildable foundation, central policy and initial REST/MCP entry points.

- M1-A1: A pnpm-locked foundation passes lint, typecheck, build and meaningful
  tests with a 90% floor for lines/statements/functions/branches of domain/server
  logic on Node 26, with justified exclusions. Demonstrate that
  an invalid lint/type input and coverage below the floor fail their gates.
- M1-A2: Real OIDC and SAML test providers authenticate an authorized operator;
  invalid/replayed responses are rejected. Revoked sessions and disabled users
  lose protected access. Document provider configuration for both deployments.
- M1-A3: An operator granted reply access to project A can reply there and is
  denied the same operation in project B. Read-only roles cannot send replies.
  Direct resource requests, searches and mutations enforce the same policy.
- M1-A4: Scoped service identities are revocable and cannot acquire broader
  rights through REST or MCP. Access changes and relevant actions are audited.
- M1-A5: A minimal HTTPS REST/MCP slice authenticates a selected real remote
  client against the same policy core. Source-linked capability declarations and
  the difference ledger exist before feature expansion. Persisted configuration
  survives restart. Owner bootstrap/recovery and encrypted connection-secret
  boundaries pass positive and denied-access cases.
- M1-A6: English/German catalog infrastructure, ICU/plural formatting and stored
  locale preferences work in the actual framework build. Missing/malformed keys
  fail the catalog gate; valid catalogs pass. Unknown locale falls back explicitly.
  Locale routing never intercepts machine endpoints or expands protected access.

### M2: Ticket core and complete email processing

Milestone issue: [M2 #3](https://github.com/metaneutrons/aidesk/issues/3).
Dependencies: M1.
Outcome: durable tickets and complete email round-trips with clean content and
traceable delivery state across both inbound and both outbound adapters.

- M2-A1: Hosted-provider/Worker input and an actual IMAP mailbox both create
  project-correct tickets; duplicate delivery does not duplicate the message or
  acknowledgement. Message threading is checked with a real reply.
- M2-A2: Replies use each project's configured identity through provider API
  and SMTP. A provider acknowledgement is distinguished from actual delivery;
  failures and uncertain SMTP acceptance remain visible.
- M2-A3: Restarting the email worker preserves sync cursors and pending jobs.
  A simulated processing failure and UIDVALIDITY change exercise recovery.
- M2-A4: Attachments remain private; unsafe email markup cannot execute in the
  portal or operator UI. Disallowed/oversized input fails for the expected reason.
- M2-A5: Two projects send distinct configured HTML designs and corresponding
  plain-text bodies through both provider API and SMTP. Preview/test send use the
  selected template version. Verify Gmail, Apple Mail and Outlook rendering,
  mobile/dark mode and preserved outbound snapshots after a template change.
- M2-A6: HTML/plain-text fixtures cover signatures, nested quotations and inline
  replies between quotes. Extraction retains new statements, code, meaningful
  images and attachments; uncertain cases remain reviewable from the private
  original. An unsafe-markup fixture confirms sanitization.
- M2-A7: A documented development Mailpit setup captures sends without delivering
  to external recipients. Tests inspect HTML/text, From/Reply-To, ticket links and
  attachments through its API and verify retry behavior under simulated SMTP
  errors. This evidence is separate from real provider/IMAP/client qualification.
- M2-A8: Classified junk is absent from the support inbox/conversation and emits
  no acknowledgement or autonomous reply. IMAP input moves to the configured
  Junk folder; webhook input appears in aidesk junk. Test a move failure/restart
  and restoration without duplicate messages. Junk referencing a real ticket
  does not change that ticket's status or expose its content.
  Known classification outcomes qualify routing here; real AI quality and
  classifier failure behavior are qualified separately by M4-A6.
- M2-A9: Qualify Cloudflare/SMTP and IMAP/SMTP with real test connections. Each pairing preserves From/Reply-To,
  acknowledgement, HTML/text, attachment rules and a customer's reply in the
  same ticket. Configuration/health/tests are independent; adapter changes do
  not silently change the other direction. Verify junk behavior follows inbound
  and send errors/uncertain acceptance do not cause cross-provider duplicates.
- M2-A10: Review and qualify channel-aware contracts without coupling mail
  providers or assuming email-only identities/formatting. Once implemented,
  meaningful boundary tests exercise ID collisions across accounts/projects,
  duplicate input, incompatible output capabilities and unauthorized channel
  changes. No unimplemented messenger is advertised as working; selected real
  adapters require their own inbound/reply/media/status/deployment evidence.
- M2-A11: Lifecycle, participants and durable jobs pass focused integration cases:
  unknown/failed sends, late bounces, follow-up/reopen boundaries, trusted receipt
  clocks, suspicious threading, exact recipients, isolated portal grants,
  concurrent edits and worker fencing. Faults cannot silently lose admitted
  content or trigger blind retry of an uncertain external send.
- M2-A12: Source/translation revisions, language decisions and final send snapshots
  survive restart and export; corrections invalidate stale translations. Localized
  subjects/templates and shared Markdown render through both email transports.
  Contract fixtures exercise pending/failed translation, recipient-language
  mismatch, protected code/links/placeholders and deletion of derived content.
  Real semantic model quality is qualified separately by M4-A11.

### M3: Operator experience and project portals

Milestone issue: [M3 #4](https://github.com/metaneutrons/aidesk/issues/4).
Dependencies: M1 and M2 for integrated core workflows; design begins independently.
M3-A7 through M3-A11 require the relevant implemented M4 operations for real
workflow qualification, not a fully accepted M4 issue. UI and M4 execution
proceed together after core contracts exist.
Outcome: an actionable dashboard, shared filtered desk and private customer portals.

- M3-A1: The inbox supports project filtering, search, tags, private notes,
  reminders and clear sender identity through a complete support workflow.
  Drafts survive expected navigation/failure cases and send errors are actionable.
  Project filtering narrows a single shared inbox without switching workspaces,
  resetting the open ticket/draft or changing its sender. Only granted projects
  appear in filters, navigation, search/suggestions, counts and settings; enforce
  authorization before aggregation and verify removal after access revocation.
  Initial home is an actionable Overview dashboard, linking overdue,
  unassigned, draft-review and review/error cases directly to work. Counts and
  rows share authorization/query semantics; loading/error data never masquerades
  as zero. Deep links and ongoing work do not require a dashboard detour.
- M3-A2: Each project works through a verified custom domain and a shared-domain
  path. Both resolve the same ticket; a project-mismatched or revoked link fails.
  Customer access never reveals internal notes or unrelated tickets.
- M3-A3: Aurora-inspired light/dark, responsive layouts, keyboard navigation,
  focus management, reduced motion and the WCAG 2.2 AA target are qualified
  through relevant automated and manual checks, with explicit limitations.
- M3-A4: Playwright exercises the main workflows in Chromium, Firefox and WebKit,
  including loading, empty, error and missing-permission states.
- M3-A5: Operator and customer conversations display message content without
  email branding, signatures or repeated history. A permitted operator can inspect
  and correct uncertain extraction; originals remain inaccessible to other tickets
  and projects. HTML/text email and chat preserve the same message semantics.
- M3-A6: The original-mail action opens an accessible HTML overlay/panel with a
  text fallback. Script/form/remote-resource fixtures exercise isolation; authorized
  CID images render, and project-mismatched requests fail. Keyboard close/focus
  return work without losing the conversation position.
- M3-A7: A representative operator/customer walkthrough qualifies project identity,
  reply vs internal note, draft/send recovery, original preview, junk restoration,
  AI takeover and mobile customer reply. Record completion/errors and resolve
  critical workflow failures; visual polish alone is not usability evidence.
- M3-A8: A project with a repository offers search/link/create-draft from its ticket
  inspector. Repository-free projects omit these controls. The exact publish
  content is reviewable; denied create access and send failures retain the draft.
- M3-A9: Human/AI assignment, queued/draft-ready/failed states and review/takeover
  are understandable in the ticket workflow. Oldest unanswered and Overdue show
  correct durations and eligible-project results without losing current drafts.
- M3-A10: Authorized settings configure connections, per-task models and project/
  agent mappings with effective defaults shown. Connection/task tests report real
  outcomes without production side effects; execution details retain prior profile
  revisions after changes. Credentials are never returned to the UI/client.
- M3-A11: Operator and portal workflows pass in English/German, including forms,
  errors, accessibility text, dates/plurals and mobile layout. Locale changes keep
  drafts/ticket identity. Translated content is clearly labeled, original-text
  access preserves permissions, and composers preview the exact customer-language
  result. Exercise pending/failure/stale/unsupported-language states and manual
  correction with real M4 translation operations, including no silent wrong-language
  send or private-note disclosure. Original text and original-mail preview remain
  distinct, understandable actions.

### M4: MCP, API, knowledge and autonomous AI

Milestone issue: [M4 #5](https://github.com/metaneutrons/aidesk/issues/5).
Dependencies: M1 and M2. Full parity requires implemented M3 controls/routes and
declarations, not acceptance/closure of the whole M3 milestone. M4 operations
unblock M3's integrated AI/GitHub/settings checks. Collect current cross-surface
evidence together; mock-only UI evidence cannot satisfy real integration gates.
Outcome: remote control, project-scoped knowledge and governed multi-provider AI.

- M4-A1: A real remote client connects to authenticated HTTPS MCP and performs
  permitted ticket operations. Missing credentials/scopes and project mismatch
  are rejected. REST and MCP invoke the same domain functions.
- M4-A2: The capability registry/parity gate passes for the declared surfaces;
  an isolated declaration/source mismatch fails. Differences have documented
  reasons rather than silently missing operations.
- M4-A3: GitHub issues, documentation and verified customer context are retrieved
  with project boundaries, source references and freshness/error metadata.
  Cross-project/customer requests fail; unavailable sources are not fabricated.
- M4-A4: A ticket event triggers an AI runner that can reply and close a ticket
  under project rules. A disallowed action and manual takeover prevent further
  autonomous sends; retries/stale revisions do not silently duplicate actions.

- M4-A5: AI-assisted extraction is optional and scoped to the authorized ticket.
  Enabling it for a project automatically processes every admitted incoming email from
  both ingress adapters without a user action or mandatory manual approval.
  Fixtures cover quoted histories, inline replies, attempted instructions within
  mail, failure/context limits, duplicate input, restart recovery and a stale job
  racing a manual edit. Disabling AI keeps ingestion functional. Failure exposes
  parser fallback, final content precedes downstream automation, and provenance
  plus originals/parser content remain available.
- M4-A6: AI junk detection correctly handles spam/advertising and genuine support
  fixtures, including complaints, inline replies and attempted classification
  instructions inside a mail. Uncertain results and classifier failure remain
  reviewable without unchecked automated sends. Project access, independent
  extraction/classification configuration, retained provenance and an authorized
  false-positive restoration are qualified.
- M4-A7: Issue search/link/create enforce project/action/repository boundaries
  through UI, REST and MCP. Read-only principals cannot publish. Retries do not
  create duplicate issues, authenticated updates/reconciliation refresh status,
  and issue closure leaves ticket status unchanged without an explicit rule.
  Private notes/customer data are not automatically included in published issues
  or exposed through customer portals.
- M4-A8: Human/AI assignments enforce project/action scope through UI/REST/MCP.
  Assignment produces a durable reply job; draft-only agents cannot send/close.
  Reassignment/revocation prevents a stale job from sending. With controlled time,
  verify that notes, acknowledgements, customer follow-ups and drafts do not reset
  response age, while a substantive reply ends the cycle and delivery failure
  restores it. Thresholds fire once per cycle across restart/retry, with no stale
  escalation racing a reply; unauthorized handoff fails.
- M4-A9: Two real model-provider connections execute different assigned tasks
  under the same core contract. Structured-output/capability failures, forbidden
  provider/context scope, budget limits and timeout/fallback behavior are exercised.
  No retry repeats committed sends/tools. Record representative classification/
  extraction/reply fixture results and usage; external MCP agents remain functional
  without pretending their model settings are controlled by aidesk.
- M4-A10: Workspace/project/ticket stops, outbound pause, fresh policy checks,
  step/reply limits and budget reservations prevent unauthorized side effects
  across race/retry/restart cases. Unknown acceptance cannot cause automatic
  provider fallback. Resume requires current input/revision and preserves audit;
  intake remains usable while support-agent actions are paused.
- M4-A11: Real provider-backed message/template translation uses independently
  assigned profiles through UI/REST/MCP with project permissions and budgets.
  Representative English/German and third-language fixtures retain intent,
  negation, terms, amounts, Markdown/code/links and identifiers. Test source-language
  detection, injected instructions, failed/timeout output, unauthorized context,
  duplicate/stale jobs, manual review and rule-governed autonomous outgoing replies.
  Source content remains authoritative; translations cannot trigger sends or
  resets by themselves. Record semantic review and exact model/profile revisions.
- M4-A12: Draft assistance in free-text fields. Wherever an operator writes a
  message or a comment (the reply composer and the internal note, and any later
  field of that kind), a visible, keyboard-operable button drafts the text with
  an AI. It uses the visible conversation of the ticket (the internal notes for a
  note) and what the operator has already typed as the starting point, and puts
  the result into the field as editable text, never sending anything; the earlier
  text can be restored with one action. A standard prompt per mode (reply, note) is
  used by default and is a project text in the catalog of the API initiative
  (English and German, versioned, editable); the operator may instead send a custom
  instruction for this one draft. The assist runs under the project's reply-drafting
  profile with its budget and limits, needs `ticket.read` and the right to write in
  that mode, and sends the ticket content only to the provider the profile names.
  Customer text is data: injected instructions in it must not change the task, the
  recipient or the language, and the draft is written in the ticket's outgoing
  language. Failure, timeout or an unconfigured profile leave the typed text
  untouched and say why. The use is audited (who, ticket, mode, whether a custom
  instruction was used, model and profile revision) without storing the prompt or
  the draft. Progress and result are announced to assistive technology. REST offers
  the same operation; MCP does not, since an agent writes its own drafts. Tests
  cover both modes, a typed starting text, the standard and a custom prompt, a
  conversation with an injected instruction, a failing provider, a stale or
  forbidden ticket, the budget limit and the audit entry, with a real provider run
  recorded as in M4-A9.

### M5: Deployment and operational qualification

Milestone issue: [M5 #6](https://github.com/metaneutrons/aidesk/issues/6).
Dependencies: M1 through M4.
Outcome: the same qualified product runs on Vercel and Docker with measured
recovery and actionable operational health.

- M5-A1: The functional acceptance suite runs against both Vercel and Docker
  deployments, including real HTTPS MCP, custom domains, mail input and replies.
- M5-A2: A documented Compose setup starts app, worker and persistent services
  from a clean state. External database/object storage configurations also work.
  Runtime configuration contains no credentials baked into images.
- M5-A3: Controlled migrations, health/readiness behavior, graceful shutdown,
  restart recovery and database/attachment backup restoration are demonstrated.
- M5-A4: Repository CI/hooks and GitHub configuration are audited against the
  applicable gitrepo profile using local checks and its read-only API checker.
  Required checks correspond to real reported contexts; omissions are explicit.
- M5-A5: Export/retention/deletion and key rotation work on selected database and
  object services. Restore re-applies deletions and remains isolated with delivery
  paused. Current measured results support the selected RPO/RTO targets on both
  deployment paths; unmet targets stay blockers, not claimed achievements.
- M5-A6: Health exposes actual stuck/review/failed/uncertain work, with scoped
  counts, correlation IDs, incident deduplication and safe resume. Exercise backlog
  and authentication/send failures; a reachable app cannot report failed or
  unprocessed customer mail as handled.
- M5-A7: Both Vercel and Docker qualify localized staff/portal routes, templates,
  translation jobs and actual send snapshots. Locale/cache boundaries cannot leak
  another project, participant or private note. A translation provider outage keeps
  English/German UI usable and visibly blocks only affected outgoing work.

The initiative is qualified only when all applicable criteria and dependencies
have current evidence. A deployed or merged slice alone is not completion.
Publication is a separate scope requiring resolved channels and authorization.

## Migration, risks and verification cost

The concept review and behavior proposal informed the operational decisions
above. They are historical research inputs, not separate acceptance authorities.
UI and AI qualification dependencies are defined at capability level to avoid
a milestone closure cycle. Actual IdPs, mail/DNS, model providers and customer
API schemas remain integration prerequisites to gather during their milestones.
No application evidence or measured service levels exist yet.

This is an initial build, not a production-data migration. Future schema changes
need controlled migrations and a tested restoration path; deleting stored tickets
or running an application release is outside this tracking setup. Document
expand/migrate/contract changes; back up before destructive migration and test
rollback or forward recovery on the relevant revision. Staged deployment and
reversible feature flags protect integration changes. Never recover a migration
by silently dropping tickets or encryption keys.

Important investigation points are SSO-provider integration, newer package
compatibility, email delivery ambiguity and portable scheduling/storage behavior.
Use focused tests during development and the Node 26/browser/deployment checks
at the relevant qualification points. No measured CI budget or delivery estimate
exists yet; this plan makes no cost or deadline commitment.

## Decision changes

- 2026-10-11: Incorporated the user's confirmed product scope, pnpm requirement,
  Vercel/Docker deployment, OIDC/SAML, granular access and Aurora-style UX.
- 2026-10-11: Read the supplied gitrepo skill. Replaced the earlier suggestion of
  Biome as the main linter with its required type-aware ESLint configuration and
  recorded the binding TypeScript `~6.0` constraint. No implementation evidence
  is invalidated because application implementation has not started.
- 2026-10-11: The user explicitly limited CI to Node 26. Removed Node 24 from
  the proposed CI qualification and M1-A1; this overrides the skill's default
  matrix. There is no existing application CI evidence to invalidate.
- 2026-10-11: Added project-specific styled HTML email and clean inbound reply
  extraction as mandatory requirements, with separate content/rendering and
  acceptance criteria M2-A5, M2-A6 and M3-A5. Implementation has not started.
- 2026-10-11: Added Mailpit to development/testing scope with criterion M2-A7;
  SMTP capture does not substitute for provider, IMAP or real mailclient tests.
- 2026-10-11: Adopted Markdown message content and added original-mail previews
  plus optional contextual AI extraction (M3-A6 and M4-A5). Originals and previous
  extraction revisions remain available; no application implementation exists yet.
- 2026-10-11: Clarified that optional AI extraction is a project-enabled input
  pipeline stage for every incoming email, rather than a per-message user action
  or uncertain-case-only fallback. Updated M4-A5; no implementation evidence exists.
- 2026-10-11: Added inbound AI junk classification, project-scoped junk storage,
  IMAP folder movement and false-positive restoration (M2-A8 and M4-A6). Only
  admitted mail continues to content extraction and downstream automation.
- 2026-10-11: Specified a shared-desk UX with lightweight project filters rather
  than workspace switching. Visibility is limited to authorized projects across
  all surfaces, including suggestions/counts; updated M3-A1 and the UX concept.
- 2026-10-11: Added ticket/issue links, issue status and a scoped explicit
  create-issue draft flow for projects with repositories (M3-A8 and M4-A7).
  This extends the previously read-only knowledge proposal without enabling
  autonomous external writes or executing GitHub publication during planning.
- 2026-10-11: Added human/named-AI assignment with durable reply tasks and a
  response-age inbox plus project escalation thresholds (M3-A9 and M4-A8).
  Draft creation alone does not satisfy response deadlines.
- 2026-10-11: Made Cloudflare a mandatory first-class adapter and separated
  inbound/outbound configuration, including mixed provider pairings (M2-A9).
- 2026-10-11: Reserved WhatsApp, Signal and Telegram in an extensible channel
  model with independent inbound/outbound handlers. Initial messenger delivery
  is undecided; retained mandatory email scope and added criterion M2-A10.
- 2026-10-11: Added provider connections, versioned per-task profiles and scoped
  agent mappings; proposed AI SDK Core/direct providers with optional gateway
  and real qualification criteria M3-A10/M4-A9. No model integration is built yet.
- 2026-10-11: Reviewed the full concept/plan/UX, documented remaining decisions
  in `aidesk-concept-review.md` and clarified original retention for preview.
  No application evidence, scope or milestone completion is implied.
- 2026-10-11: The user authorized an epic and ordinary milestone issues.
  Consolidated operational contracts, configurable defaults and 90% domain/server
  coverage into this authority. Added M1-A5, M2-A11, M4-A10 and M5-A5/A6; retained
  earlier criterion IDs. Clarified M3/M4 dependencies without circular closure.
  GitHub API access was initially blocked; a subsequent real API read succeeded.
  Tracking is authorized and is being established separately from implementation.
- 2026-10-11: Added user-required multilingual UI and AI communication translation.
  English/German are MVP UI locales; communication languages are independently
  configurable with qualified provider-backed translation. Added M1-A6, M2-A12,
  M3-A11, M4-A11 and M5-A7 without renumbering earlier criteria. All application
  and translation evidence remains outstanding.

- 2026-10-11: Verified repository/API access and established the epic plus five
  ordinary milestone issues. Filled reciprocal links from their actual IDs;
  implementation, qualification and application release remain outstanding.
- 2026-10-11: Updated the gitrepo revision from `6e0b80e` to `1605047`. The
  only change is the pre-commit lockfile guard, which now asks pnpm whether the
  staged lockfile satisfies the staged manifests instead of requiring a lockfile
  change with every `package.json` change. No requirement changes.
- 2026-10-11: The user identified Silo as `pgsty/silo`. Adopted it as the local
  Docker object store in place of SeaweedFS; aidesk keeps using the generic S3
  boundary, so external object storage remains supported. Production key scoping,
  backup and restore for Silo remain M5 qualification.
- 2026-10-12: Cloudflare inbound runs through an Email Worker that stores each
  message unchanged in an R2 bucket (EU jurisdiction); aidesk collects and then
  deletes the objects through the S3 API. Mail therefore waits while aidesk is
  unreachable, and the same path works for local, Docker and Vercel
  deployments. A push notification from the worker is a possible later latency
  improvement, not a requirement. Outbound uses the Email Sending REST API;
  Cloudflare assigns the Message-ID, which aidesk stores for threading. Without
  Workers Paid, sending is limited to verified destination addresses, which is
  enough for M2-A9 test connections but not for production.
- 2026-10-12: The owner decided against the Cloudflare Workers Paid plan.
  Outbound mail uses SMTP (SMTP2GO); M2-A9 qualifies Cloudflare/SMTP and
  IMAP/SMTP only. The Cloudflare Email Sending adapter stays in the code and
  is tested, but it is not part of v1 acceptance because it can reach only
  verified destination addresses. Reintroducing it later needs a new decision
  and its own qualification.
- 2026-10-13: M2 execution reached its second state: language decision
  (explicit ticket choice, requester preference, detection, project default),
  translation records with protected-content checks, portal grants, versioned
  email designs, sent-mail snapshots, late bounces and an external-key scope per
  project are merged with tests and mutation counter-probes. Evidence per PR is in
  issue #3. Open for M2: M2-A9 with a real IMAP mailbox, and for M2-A5 a test
  send and the check in Gmail, Apple Mail and Outlook. A provider webhook for
  SMTP2GO bounces is not planned for v1 and is recorded as a limitation.
- 2026-10-14: Added M4-A12 (draft assistance in free-text fields) at the request of
  the product owner: a button next to every message or comment field that drafts
  the text with an AI from the conversation and what was typed, with a standard
  prompt and an optional custom one. Open: whether the customer portal's reply
  field gets the same button (assumed not, since the portal speaks for the
  customer), and whether editing the standard prompts needs `config.write` only.
