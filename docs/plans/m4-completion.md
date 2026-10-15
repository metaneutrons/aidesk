# Completing M3 and M4: managed agents, intake AI, translation, knowledge and the desk

Initiative of 2026-10-15 at the request of the product owner ("build M4, finish M1 to
M3"). It refines the criteria of [the initial product plan](initial-product.md) that are
still open; it adds none and changes none. Acceptance authority stays with the criteria named
under each part, and each part has its own issue. A part is accepted when its criteria have
current evidence against the revision of this plan; the milestones M3 and M4 are accepted when
their parts are, together with the criteria that need real systems and people (part P7).

## Baseline on 2026-10-15

Exists:

- The AI boundary `runAiTask` with task profiles, budgets and run records (C6), drafts for
  operators (M4-A12), reading of images and scans through the model (C5-A5).
- Agents as service identities with grants and an expiry, assignment of a ticket to an agent
  over REST and MCP (a record: no job, no event, no state), `approvalPolicy` (`review` makes an
  agent's reply a draft, `direct` queues it), and `pauseOutgoing`, which the worker checks again
  before a send. The worker also checks `stopAutonomous` and that the agent is assigned, but
  that switch cannot be set anywhere.
- The job queue with leases, retries and review, the response clock (`pendingSince`, overdue),
  the inbound pipeline with a junk decision by rules and a parser for quoted replies,
  translation records with their staleness rules and a check of protected segments, and
  settings for task profiles.

Missing:

- Anything that runs a model on a ticket by itself; controls at workspace and ticket level; step
  and reply limits; takeover.
- The AI steps of intake (extraction, junk), and a place for them outside the database
  transaction of the intake.
- The translation provider, job, routes and display.
- GitHub, documentation and customer context as sources, and issue search, link and create.
- In the desk: the assignee and its states, translations, creating and editing connections;
  in the portal: attachments and custom domains; the observed walkthrough and the manual
  accessibility checks.

## Decisions taken for this initiative

These follow the plan of the initial product ("AI policies and stop controls") and are
recorded here so that they can be changed before the parts are built.

1. **Support modes per project** are Manual (no runner), Draft and Autonomous; Draft is the
   default. They are the existing `approvalPolicy` plus the switch of the runner: `review` is
   Draft, `direct` is Autonomous, and a project without a managed agent or with the task
   `agent.respond` off is Manual. Autonomous sending needs the project setting, the grants of
   the agent and an assigned ticket, as it does today for external agents.
2. **A managed agent** is an agent record that the product runs itself. It has a name, grants
   that cap what the runner may do (a model never widens them) and no token. External agents
   (MCP clients with a token) keep working as before and their model settings are not
   controlled by aidesk.
3. **The runner works in bounded durable steps**: a job `agent.run` per ticket and admitted
   customer revision, at most eight model calls, at most one public reply per such revision
   (the idempotency key is derived from the ticket and the revision), side effects only
   through the same operations a person or an external agent uses, with the checks of the
   worker repeated immediately before each side effect.
4. **Stops** exist at workspace level (the owner), project level (`stopAutonomous` in the
   configuration document) and ticket level (a flag set by a person or by a takeover), next to
   the separate pause of outgoing delivery. A manual reply, a reassignment or a stop on a
   ticket is a takeover: the runner does not send for that ticket until a person resumes it,
   and a resume needs the current revision.
5. **Unknown acceptance** (a timeout or a crash after a call or a send may have been
   accepted) is never retried blindly and never moved to another provider; the job needs
   intervention.
6. **Intake AI is optional and independent**: extraction and junk classification are switched
   per project, run before the content is final, and on failure the parser and the rules
   remain the result, with the failure visible. Mail text is data, never an instruction.
7. **Knowledge sources are connections** (`github`, documentation and customer context) of
   a project. Retrieval returns text with the source, the time of the fetch and an error
   state, never invented text, and never crosses the project.

## Parts

### P1: Managed agents and assignment

Execution: P1 issue. Criteria of the initial plan: M4-A8, M3-A9 (assignment and AI states).

- P1-A1: A person with the right to manage a project creates and revokes a managed agent
  (name, grants, no token) through REST, MCP and the settings page. Assigning a ticket to a
  managed agent writes one durable `agent.run` job for the customer revision it was assigned
  at; asking again does not write a second one. Reassignment, revocation, deactivation, junk,
  resolution of the ticket and a stop cancel the queued job, and a run that has started does
  not send after any of them.
- P1-A2: The assignee is shown and set in the desk, with the state of AI work (queued, running,
  draft ready, sent, failed, stopped, needs a person) and the same over REST and MCP; the event
  `ticket.assigned` goes to webhooks. A reply of an agent for a ticket it is not assigned to
  is refused when it is made, not only when it is sent. A draft-only agent cannot send or
  resolve; an unauthorized handoff fails.
- P1-A3: With controlled time: notes, acknowledgements, customer follow-ups and drafts do not
  reset the response age; a substantive reply that was sent ends the cycle and a delivery failure
  keeps it; warning and overdue thresholds are configurable and fire one event each per cycle
  across restart and retry, never after the reply that ended the cycle.

### P2: The runner and its controls

Execution: P2 issue. Criteria: M4-A4, M4-A10, and the part of M4-A9 about failure behaviour.

- P2-A1: A new customer message or an assignment on a ticket of a managed agent triggers the
  run. The run reads the conversation, may read attachments and search knowledge, and may
  reply, write a note or resolve, under the project's mode and the grants of the agent. A
  disallowed action is refused and recorded, a manual takeover stops further autonomous sends,
  and retries, duplicated events and stale revisions neither repeat nor invent an action.
- P2-A2: Each run is recorded with its steps, the tool calls, the usage per call and its end;
  a limit of steps or of replies ends it; a budget that is too small ends it before the call;
  a provider failure ends it without moving to another provider when the acceptance is
  unknown; fallback to an approved model is used only after a refusal that did nothing.
- P2-A3: Stops at workspace, project and ticket level and the pause of outgoing delivery
  prevent side effects in race, retry and restart cases (checked immediately before each);
  intake stays usable while agents are paused; resuming needs the current revision and
  leaves the audit.

### P3: AI at intake

Execution: P3 issue. Criteria: M4-A5, M4-A6.

- P3-A1: Extraction of the new content of a mail (quoted history, inline replies) by a model
  can be switched on per project; it then processes every admitted incoming mail from both
  adapters without a user action, before the content is final. Fixtures cover quoted
  histories, inline replies, instructions inside a mail, failure, context limits, duplicates,
  restart and a stale job racing a manual edit. Failure keeps the parser result and says so;
  the original and the parser content stay available; provenance is kept.
- P3-A2: Junk classification by a model is switched separately and keeps the rules as a
  floor. Spam and advertising are classified as junk, genuine support mail (complaints, inline
  replies, instructions inside a mail) is not; an uncertain result and a failure leave the
  mail reviewable and cause no unchecked send; an authorized false-positive restoration
  works; the configuration of extraction and classification is independent.
- P3-A3: The AI call of intake is outside the database transaction, ordered after the raw
  object is stored and before the ticket is created, with a bounded wait.

### P4: Translation

Execution: P4 issue. Criteria: M4-A11, and the translation display of M3.

- P4-A1: A task `message.translate` (and `template.translate`) with its own profile; a job
  translates the current revision of a message or a template into a language; the result
  keeps intent, negation, terms, amounts, Markdown, code, links and identifiers (checked by
  the protected-segment rules and by fixtures), is marked as machine translation with the
  profile and its revision, never replaces the source and never sends or resets anything by
  itself.
- P4-A2: Routes and tools (request, list, correct, delete), project permissions and budgets;
  detection of the source language; injected instructions, a failed or timed-out output,
  an unauthorized context, duplicate and stale jobs and manual review are covered.
- P4-A3: The desk shows the translation beside the source with its state; the portal shows the
  customer's language; a provider outage blocks only the affected outgoing work.

### P5: Knowledge and GitHub

Execution: P5 issue. Criteria: M4-A3, M4-A7, M3-A8.

- P5-A1: A `github` connection of a project (token, repositories) and sources of
  documentation and of customer context; retrieval with project boundaries, source
  references, freshness and error metadata; cross-project and cross-customer requests fail
  and an unavailable source is reported, not filled in.
- P5-A2: Issue search, link and create-draft from a ticket through desk, REST and MCP with
  the right `github.publish` and the repository boundary; read-only principals cannot
  publish; a retry creates no second issue and an uncertain creation is not blindly repeated;
  status is refreshed by an authenticated update or by reconciliation; closing an issue
  leaves the ticket as it is; private notes and customer data are never added to a published
  issue or shown in the portal by themselves.
- P5-A3: The runner and the draft button can search the knowledge of the project and cite the
  sources.

### P6: The rest of the desk

Execution: P6 issue. Criteria: M3-A3, M3-A7, M3-A10, M3-A11, M3-A2 as far as it is decided.

- P6-A1: Connections are created and edited in the settings page (the forms for the kinds
  that exist, with the secret never shown again), with the approval flow of the API.
- P6-A2: Customers can attach files to a portal reply under the limits of the intake, scanned
  like any received file.
- P6-A3: A representative walkthrough of operator and customer, with the keyboard, zoom,
  German and English, light and dark, and a screen reader where one is available, is recorded
  with what was found and fixed; what could not be done by the product owner's tooling is
  named. Custom portal domains are built when the domain decision is taken.

### P7: Qualification with real systems

Execution: P7 issue. Criteria: M4-A1, M4-A9, M1-A5, M2-A9, M5-A1.

- P7-A1: A remote MCP client connects over HTTPS to a deployed staging instance and performs
  permitted ticket operations.
- P7-A2: Representative fixtures of classification, extraction, translation and reply drafting
  run with real providers (at least two), with results, usage and the profile revisions
  recorded.
- P7-A3: The functional suite runs against the staging deployment on Vercel as well as against
  Docker, as far as the platform allows, and the differences are written down.
- P7-A4: What needs a real mailbox or identity tenant (M2-A9, M1-A2 against a production
  provider) is run when the owner provides it; until then it stays a named blocker.

## Order and dependencies

P1 and P2 first (the runner needs a managed agent and the stops); P3 and P4 are independent of
them and of each other and use the same boundary; P5 follows P2 for the runner's search; P6
runs alongside; P7 closes. Every part is delivered in pull requests that each carry tests and
mutation probes, and real-provider runs are recorded in the issue of the part.

## Risks

- A model with tools can do harm through text it reads. The mitigations are structural: the
  grants cap the actions, text from customers and sources is data between markers, one reply
  per revision, drafts by default, and every side effect passes the same operations and
  checks as a person's.
- Provider behaviour differs; a profile is qualified by fixtures, and the settings page says
  that small models follow injected instructions more often.
- Vercel limits (Node 24 at most, short functions, one cron a day on the free plan) may make
  parts of the worker run differently from Docker; the differences are recorded in P7.
