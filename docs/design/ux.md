# aidesk UX concept

Status: agreed design direction, 2026-10-11. Requirements and acceptance are
owned by [the implementation plan](../plans/initial-product.md). This is a reviewable concept,
not an implemented interface or a usability-validated design. Application and
browser qualification remain pending. All labels below are illustrative; the
German equivalents apply when the user selects German.

## Product promise

An operator can understand which project a request belongs to, what the customer
needs and what happens next without leaving the conversation. Daily work focuses
on a shared support inbox, with clear project identity and background automation.
The primary user is one developer supporting several projects; one to three
operators share the same workflows and permissions.

## Design references

Use Linear as a reference for information density, issue detail, consistent
controls and keyboard-oriented navigation; Front for shared-inbox ownership,
email conversations and collaboration; Intercom for customer messaging and visible
automation/handoff. Apple Human Interface Guidelines and Vellum's Aurora direction
inform hierarchy, focus, typography and restrained materials. These are aspect-
specific design references rather than an existing tested aidesk UI or a promise
that one product solves our project/API/MCP requirements unchanged.

Official references: https://linear.app/features, https://front.com/,
https://www.intercom.com/ and
https://developer.apple.com/design/human-interface-guidelines/.
Their web pages were blocked by this environment's egress policy on 2026-10-11;
no current live product UI or screenshot walkthrough was verified here.

## Home dashboard

Use Overview as the initial application home, answering What needs attention
now? Inbox remains one direct navigation action away. Deep links open the requested
ticket after login, rather than forcing a dashboard detour. Returning to an ongoing
session preserves the operator's current work; project filtering does not navigate
to another workspace or reset a draft.

```text
Overview                             [Authorized project filters]
┌─────────────────┬─────────────────┬─────────────────┬─────────────────┐
│ Overdue         │ Unassigned      │ Drafts to review│ Needs checking  │
│ Open view       │ Open view       │ Open view       │ Open view       │
└─────────────────┴─────────────────┴─────────────────┴─────────────────┘
Needs attention now
Project · Ticket/customer · Waiting time · Assignee · Reason · Open ticket
… prioritized actionable rows …

Compact health summary / recent handoffs, available on demand
```

Counters lead to the exact filtered inbox/intake view; the primary list leads
straight to the relevant ticket/draft/incident. Prioritize overdue obligations,
failed/uncertain delivery and review-needed intake, then actionable drafts and
unassigned requests. Every row shows the reason and meaningful response age;
total ticket age remains separately available. Do not equate ticket updates or
generated drafts with a resolved response obligation.

Derive counts and rows from the same permission-filtered authoritative queries.
Categories can overlap, so do not sum them into a misleading total. Never include
inaccessible projects, private notes or restricted health details in aggregates.
Different roles see the same dashboard structure with only their permitted actions.
Counts are loading/failed/stale explicitly rather than falling back to invented
zeroes. Empty state explains No action needed and still offers inbox navigation.

The first version focuses on actionable operations. Historical response charts and
reporting can be additional views when needed. User preferences may later choose
Inbox as home; Overview is the recommended initial default. This dashboard remains
a proposed design, not an implemented screen.

## Desktop structure

```text
┌────────────────┬─────────────────────┬────────────────────────────────────┐
│ aidesk         │ Needs attention     │ Project · Ticket number · Status   │
│ Project filters│ Search / filters    │ Subject                            │
│                │                     │ Customer / latest activity         │
│ Needs attention│ Project · Customer  ├────────────────────────────────────┤
│ Waiting        │ Subject             │ Customer message                   │
│ Done           │ Latest new text     │                            Our reply│
│ Junk           │ Age · Owner · State │ Internal note, clearly distinguished│
│                │                     │                                    │
│ Projects       │ …                   │ [Original email] on incoming mail  │
│                │                     ├────────────────────────────────────┤
│ Settings       │                     │ Reply | Internal note              │
│ Profile        │                     │ Markdown composer                  │
│                │                     │ From: Project support identity     │
│                │                     │ Send ▾                             │
└────────────────┴─────────────────────┴────────────────────────────────────┘
```

The desk has three principal regions: navigation, ticket list and conversation.
Customer/project context opens on demand in an inspector rather than consuming
a permanent fourth column. Region widths can adapt to the window; a narrow
screen navigates list → ticket, with retained filters and scroll position.

Navigation starts with Overview, followed by Inbox views Needs attention,
Waiting, Done and Junk, with an Overdue view
and an Oldest unanswered sort within the shared inbox. These are views over
explicit ticket/ingress states, not competing status fields. Needs attention
includes new customer messages, due reminders, failed sends and automation cases
requiring a person. One visible reason explains each ticket's inclusion.

## Project filters and access

Use one shared desk rather than switching project workspaces. The default list
contains tickets from all authorized projects. Lightweight project chips or a
multi-select filter narrow the list to one or several projects; clearing filters
returns to all authorized projects. Filtering updates the list without a full
page reload or layout/context switch. It does not change the currently open
ticket, its draft, recipient or sender. The ticket itself determines project
identity. Project name remains visible in every list row, ticket header and
composer; color alone never identifies a project. Filters, selection and draft
state are restored when navigating back; selected tickets have deep links.

Only projects granted to the current principal are visible anywhere: filter
options, navigation, search suggestions/results, counts, settings, activity and
API/MCP discovery. Do not display inaccessible project names in disabled options.
List/search/count queries apply authorization before aggregating or filtering.
Direct links and stale client caches never bypass the policy. Access revocation
removes protected data from the UI/cache and blocks further reads/mutations;
project visibility and individual action grants remain distinct permissions.

Search respects the current project filters and visibly offers searching all
authorized projects. A command palette supports navigation and ticket actions;
all actions also have discoverable buttons or menus. Keyboard shortcuts do not
intercept typing in the composer and are optional on touch devices.

## Conversation and composing

Public replies form a readable chronological conversation with author, time and
delivery state. Internal notes have a distinct label and subtle background,
not merely a different text color. Quiet system events can be expanded when
needed. Markdown formatting retains lists, links, tables and code, while mail
branding, signatures and quoted history are absent from the main conversation.

The composer has explicit Reply and Internal note modes. Switching mode changes
both its label and primary action (Send reply / Add internal note); an internal
note never enters the email outbox. Project sender and customer recipient are
visible before sending. Attachments show upload state, name and removal controls.
Plain Markdown editing starts simple, with formatting controls and preview;
formatting shortcuts preserve normal text-editing behavior.

Drafts are saved per ticket, operator and mode, with visible saved/error state.
Navigating away cannot silently discard text or pending attachment work. A normal
send uses the current status; Send and close is an explicitly labeled alternative.
Request acceptance, transport acceptance and actual delivery have different
states. A failed send retains the composed content and offers a retry that cannot
create duplicate replies. Success feedback is factual, rather than asserting
delivery before a provider confirms it.

## Original email

Each incoming message has a secondary Original email action. On desktop this
opens a wide side panel or modal chosen consistently for the implementation;
on mobile it opens a full-screen view. Keep sender, subject and date visible.
The primary pane renders isolated, sanitized HTML including old quotes and
signatures; a plain-text pane is available. Inline CID images retain authorization.
Remote content is blocked initially with an understandable explanation. Scripts,
forms and application-origin access are never enabled. A user can close the
preview by keyboard and return to the triggering message without losing position.
If the original expired under retention, state that clearly and keep the stored
message available. Do not show a broken preview that looks like an empty mail.

## Background AI and intake

Junk classification and content extraction are independent project settings.
When enabled, each stage runs in the input pipeline without a per-message button.
Keep the saved original, classification and resulting Markdown traceable. Normal
successful processing does not produce distracting notifications. Processing
delay, fallback or a review-needed result is visible in an intake view/status
that authorized operators can inspect. Customer portals do not expose classifier
internals or raw pipeline states.

Only admitted, processed messages reach support conversations and downstream
acknowledgement/reply automation. Junk stays in its own project-scoped view with
sender, subject, date and classification reason. Opening an item offers the same
original-mail preview. Restore to inbox resumes the pipeline; it is reversible
and does not duplicate tickets or replies. An IMAP folder-sync failure is shown
separately from the aidesk classification. Uncertain or failed classification is
reviewable and never silently discarded or automatically answered unchecked.

Autonomous support processing has a concise ticket-level status, for example
AI is handling this, Waiting for you or Automation failed. Take over is prominent
while autonomy is active, and must stop pending autonomous sends server-side
before the UI claims success. Action history exposes actual performed operations,
sources and failures on demand. Access settings govern who may take over or
change rules; customers see actual replies rather than AI execution machinery.

## Assignment and waiting time

The ticket header has one accountable assignee: a person or named AI agent.
Show the type explicitly alongside avatar/name; list only active project-eligible
assignees. Assignment is an authorized action and never grants broader access.
An AI assignment queues a durable reply task. Its configured mode either produces
a Markdown draft for a human reviewer or allows autonomous sending under project
rules. Draft ready appears in Needs attention, with a clear review/send action.
Show queued, working, draft ready and failed states; takeover/reassignment stops
the old task's authority before indicating success. Intake AI is a separate role
from an assigned support agent.

Oldest unanswered ranks by the first still-unanswered customer message, not last
activity. A row shows Waiting 6h, assignee and deadline/overdue state in text and
color; expose the actual starting timestamp on inspection. Opening, reassignment,
notes, further customer messages, acknowledgement and AI drafting do not reset it.
A successfully sent substantive public reply completes the cycle, while failed
sends do not; a delivery failure reopens the obligation. The next customer reply
starts a new cycle. Total ticket age is separate and can remain visible for long
unresolved conversations. No activity metric can silently masquerade as reply age.

Per-project thresholds warn and escalate. Overdue tickets become prominent and
can generate internal alerts or hand off to an explicitly configured eligible
person. Show the reason and next expected action, including an AI draft awaiting
review. Waiting for customer has no active reply clock once answered; snoozing
does not erase an unanswered obligation. Use elapsed time initially, retaining
room for later business-hour policies. Scheduler execution and history belong
in operational details rather than customer conversation bubbles.

## Project setup and administration

Project setup has four resumable steps: identity, channels, customer portal and
automation/knowledge. Email has independent Incoming mail and Outgoing mail
sections, each with provider/handler selection, credential fields, health and
verification tests. Cloudflare is a first-class option in both directions;
IMAP input and SMTP output remain available. A mixed Cloudflare-in/SMTP-out
setup is as direct as choosing the same provider for both. Multiple ingress
addresses can map to authorized sending identities; show From and Reply-To
and validate that customer replies return to a configured inlet. Do not change
one handler silently when the other selection changes.
Channel settings also reserve WhatsApp, Telegram and Signal connection types;
the initially implemented messenger set remains undecided. Only implemented
adapters have actionable connect controls. Unavailable options are clearly marked,
not fake working integrations. A ticket shows the channel and account/chat identity
beside its project; the composer shows the actual reply destination and supported
format/media/template constraints. Reply to the originating chat by default;
cross-channel sending requires an explicitly verified destination and policy.
Channel badges/filters narrow the same shared desk without workspace switching.
Keep mail-specific HTML preview and messenger source details context-appropriate.
Each step shows configured, verified or action needed based on a real check.
Completion includes a captured test message and a full inbound/reply workflow,
not just saved credentials. Knowledge adapters show source scope and connection
status. Later editing uses the same settings, so onboarding does not create a
second configuration model.

The email-design screen offers a live preview beside logo/color/typography/layout
controls, with samples for acknowledgement and reply. Show sender, HTML/mobile
and plain-text previews; explicit save/version and test-send actions keep the
published design distinguishable from a draft. Use safe design tokens and template
components rather than forcing everyday users to edit arbitrary HTML.

Workspace settings contain SSO, people/roles and instance-wide administration;
project settings contain identities, portal, design, integrations and automation.
Permissions have project and function granularity. Role presets start simple,
with advanced per-function settings and an effective-permissions view available.
Operators see authorized projects only. Capability availability comes from the
same registry/policy as REST and MCP; server denial still governs direct requests.

## AI configuration

Workspace AI settings separate Connections, Task profiles and Agents. Connections
contain provider/endpoint/allowed models, secure credential configuration and a
real connection test. Task profiles choose model, versioned instructions, context/
output rules, limits and explicit fallbacks for junk, extraction and reply work.
Project settings select authorized task profiles; agent settings reference those
profiles independently from service permissions and draft/autonomous-send mode.

Offer Simple settings first (connection/model per task), with prompts, limits and
fallbacks in advanced controls. Show effective settings and their source so an
operator can understand workspace defaults vs project/agent choices. Task tests
use representative fixtures without performing production sends/tool mutations.
Display actual success/failure, usage and known cost; no assumed provider support
or zero-cost result for unknown pricing. A configuration change affects new jobs,
with old execution details retaining the profile/model revision. External MCP
clients keep their own model runtime; aidesk shows their identity/actions rather
than an invented managed-model configuration.

## GitHub issue workflow

A project with a configured repository exposes a GitHub section in the ticket's
on-demand inspector. Search and link an existing issue without navigating away
from the conversation; show its number, title, status and source link. Projects
without a repository have no empty GitHub controls. Respect project/function
access and configured repository boundaries.

Create issue opens a title/Markdown-description draft beside the ticket. Review
the exact content before an explicit publish action; exclude internal notes,
customer identity and private attachments by default. Read/link and create rights
are separate. Show a failed publish with the draft retained, and prevent duplicate
issues on retry. Linked issue updates do not silently close a support ticket.
Private GitHub material never appears automatically in the customer portal.

## Customer portal

A customer's personal ticket link opens the project's branded conversation,
subject, readable status and one reply composer. No operator navigation or
internal notes appear. The same semantic Markdown content is presented in a
lighter layout. Attachment upload and send failures preserve the reply draft.
Mobile use, expired/revoked links and ticket closure have understandable next
steps; reopening behavior follows the project's policy. Portal access stays
bound to one ticket/project, even across shared paths and custom domains.

## Languages and translation interaction

Operator and customer UI are fully localized in English/German for the MVP,
including validation, status, accessibility text, dates and plurals. AI-assisted
catalog/template authoring produces reviewed deterministic versions; UI rendering
does not wait on a model. Operator locale is a saved personal preference; portal
locale and customer communication language are distinct. Changing UI language
keeps the current ticket, filters, draft and sender identity.

Show customer messages in the operator's reading language when translation is
configured. A quiet Translated from … indicator and Original text toggle keep
the source inspectable. This toggles the clean message text, not the Original
email overlay for MIME/HTML. Pending/failed translation displays the intact source
with a clear status. Switching display languages creates no extra conversation
message and does not move the response clock.

The composer shows the explicit outgoing language alongside project and recipient
identity. An operator can write in their own language and preview/correct the
actual translated customer reply before sending. Original draft and translated
send content remain distinguishable. A changed draft makes the old translation
stale; failure does not silently send the source language. Autonomous sends use
the same project/agent approval policy and freshness checks, without inventing an
interactive approval step for every permitted agent action.

Project settings expose default/enabled communication languages, automatic incoming
translation, terminology and effective task profile. Customer language preference
or explicit ticket choice is visible; weak detection/mixed recipients need an
explicit fallback or choice. Human-readable mail subjects, templates, portal
messages and implemented messenger text use the same language decision. Private
notes stay private in every language. Localized templates have an explicit reviewed
fallback; operator UI preference never silently determines outgoing mail language.

Prototype language switches, foreign-language customer input, exact outgoing
preview/correction and failure recovery on desktop/mobile. Qualify both complete
UI locales and real translation workflows against the implementation plan;
illustrative translated labels are not qualification evidence.

## Visual and interaction quality

Use Vellum's Aurora direction: system typography, readable text, consistent spacing,
subtle separators, restrained materials and semantic colors. Define light/dark
tokens for surfaces, foreground, borders, focus, danger and success; do not
derive meaning from project accents alone. Content contrast and clarity take
precedence over translucency. Motion is short, purposeful and respects reduced
motion. Hover actions remain discoverable by keyboard and touch.

Qualify visible focus, labeled controls, modal focus management, screen-reader
announcements and the WCAG 2.2 AA target. Empty, loading, offline/error,
missing-permission and expired-original states receive explicit designs. Real
customer content must not be truncated merely to preserve a pretty layout.

## Evidence needed before claiming exceptional UX

Build an interactive prototype, then observe representative solo developers and
small-team operators performing the following tasks without guided instructions:
find the next request across two projects, send with the right identity, add an
internal note, inspect an original, restore a false-positive junk item, take over
from AI, configure a project design and finish a customer reply on mobile.
Include changing UI locale without losing a draft, inspecting original text and
previewing a reply in the customer's language without confusing it with an
internal note or the original-mail preview.

Record completion, mis-sends, misunderstandings, recovery and keyboard/mobile
friction. Iterate on failures before polishing small visual details. Browser tests
cover Chromium, Firefox and WebKit, but observation and manual accessibility
checks remain necessary. This proposal has no measured usability results yet.
