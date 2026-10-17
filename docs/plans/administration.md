# Administration, ticket policies, privacy and notifications: the milestones M6 to M9

Initiative of 2026-10-17 at the request of the product owner ("check critically what an
administrator has to be able to set; there is much more to configure than the little there is").
It adds criteria to [the initial product plan](initial-product.md); the milestones M1 to M5 and
their criteria stay as they are. Acceptance authority is this plan. Each milestone has an issue, and a
milestone is accepted when its criteria have current evidence against the revision of this plan.

## Baseline on 2026-10-17

What an administrator can set today:

- **Operators and tokens** (settings): who has which of four presets (none, read, respond, manage) in which
  project, and who is disabled; tokens of agents and managed agents with their access.
- **Project configuration** (one document, as form and API): name, color, default language
  (English or German), acknowledgements on or off, link to the customer page in mail on or off, the
  approval policy, the outgoing connection, the pause of outgoing mail, and the two limits of the
  response clock (in hours).
- **Connections** (forms): mail in and out, model providers, sources of knowledge. **Texts**: the
  standard texts of the system and the instructions of the draft assistant. **Mail designs**
  with versions. **Webhooks**. **Task profiles** of the AI (connection, model, fallback, limits,
  daily budget, switch). **Stops** of managed agents and the pause of outgoing mail, at workspace,
  project and ticket level.

What is not there (found by reading the code and the settings, 2026-10-17):

| Area                   | State today                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Project lifecycle      | A project can be created and renamed; there is no archive, no delete and no export.                                                   |
| Identity providers     | OIDC and SAML providers are registered through the routes of the auth library only; no page, no test sign-in, no list.                |
| Audit                  | The audit table is written everywhere; no route lists it and no page shows it.                                                        |
| Workspace settings     | Only the two switches of the owner. Limits for files and for the lifetime of a session are constants of the code.                     |
| Usage                  | Runs and the daily budget of the AI are stored; nothing shows usage, cost or an exhausted budget.                                     |
| Operators              | Four presets only; no groups, no custom grants in the page, no invitation, no display name or signature of an operator.               |
| Customer page          | No branding of the page, no custom domain (M3-A2), the lifetime of a link is a choice at issue time only.                             |
| Policies               | The window in which a customer reply reopens a resolved ticket is a constant of 30 days. No automatic resolve, no policy per project. |
| Response clock         | Counted in plain hours. No business hours, no time zone, no holidays, no priority.                                                    |
| Ticket model           | No priority, no category. Tags are free text per ticket, with no list, rename, merge or colour.                                       |
| Routing                | No default assignee and no rules; the plan names a default agent as not built.                                                        |
| Replies                | No canned replies for operators.                                                                                                      |
| Intake                 | The rules for junk are fixed. No list of allowed or blocked senders or domains, no setting of sensitivity.                            |
| Notifications          | None for operators. Events go to webhooks only.                                                                                       |
| Retention and erasure  | No retention period, no deletion of a ticket or of a customer, no export of a customer's data.                                        |
| Overview of data flows | Nothing says which provider receives what for a project.                                                                              |
| Encryption keys        | No rotation of `ENCRYPTION_KEY` or `BETTER_AUTH_SECRET`.                                                                              |

## Principles

1. **Every setting has the three surfaces that the product has** (the page, REST, MCP where it makes sense)
   and is listed in the ledger of capabilities with a reason for each difference.
2. **A setting that decides where content goes, who can see it or whether something is sent** follows the
   approval rule of the product: a person with the right applies it, an agent proposes it.
3. **Defaults keep today's behaviour.** A project that changes nothing works as before.
4. **Destructive things are confirmed, audited without content and never silent**; an export comes before a
   deletion that cannot be undone.
5. **No setting without a test that fails when it is ignored**, and no new constant that a person would
   have to change in the code.

## M6: Administration of the workspace and the projects

Execution: M6 issue.

- M6-A1: A person with the right archives and restores a project; an archived project takes no mail,
  is read-only, does not appear in lists unless asked and keeps its data. Deleting a project needs an export
  of it first, a confirmation by name and the owner.
- M6-A2: An owner registers, lists, edits, verifies the domain of, tests and disables an OIDC or SAML provider
  in the settings, and sees which operators signed in through which. Registration through the API keeps
  working.
- M6-A3: A person with the right lists and filters the audit (by actor, action, target, time) in the settings
  and over REST, and exports it; entries never hold ticket content, secrets or addresses beyond what is
  needed.
- M6-A4: An owner sets the limits that are constants today: sizes and number of files at intake and in the
  portal, the lifetime of a session and the default lifetime of a portal link, with the old values as defaults,
  in the settings and over REST; a change is audited.
- M6-A5: A page and a route show usage of the AI per project, task and day (calls, tokens, outcomes, the
  budget and what is left), the volume of mail and the storage used; a budget that is nearly used up raises an
  event.
- M6-A6: A person who manages a project gives an operator grants beyond the presets (single actions), forms groups
  of operators and gives a group a role, invites an operator by address, and sets a display name and a signature
  per operator that replies carry. Nobody receives more than the person who gives holds.
- M6-A7: Each project can brand the customer page (name, logo, color, header text, language) and reach it through
  a verified custom domain next to the shared one (M3-A2); a link of another project or a revoked link fails on
  both.

## M7: Policies for the handling of tickets

Execution: M7 issue.

- M7-A1: Each project sets what a customer reply does to a resolved or closed ticket (reopen within N days,
  new ticket, refuse) and an automatic resolve after N days without an answer from the customer, with a
  reminder before. The 30 days of today are the default.
- M7-A2: Each project has business hours, a time zone and holidays; the response clock counts within them, and the
  warning and overdue limits can differ by priority. Without business hours the clock counts as today.
- M7-A3: Tickets have a priority and a category (a list per project, set by people, agents and routing), shown,
  filtered and available over REST and MCP; limits of the clock can depend on the priority.
- M7-A4: Each project routes a new ticket by rules (tag, sender, domain, language, words in the subject) to a
  person, a group or a managed agent, with a default and with round robin among a group; a rule that fails to
  find an assignee leaves the ticket unassigned and visible.
- M7-A5: Each project keeps canned replies with placeholders (customer name, ticket number, operator), usable in
  the composer, by the draft button and by managed agents, in both languages, with a list, change and removal that
  an agent can only propose.
- M7-A6: A person with the right lists, renames, merges, colours and removes tags of a project; renaming and
  merging change the tickets, and removing asks.
- M7-A7: Each project keeps lists of allowed and blocked senders and domains and sets the sensitivity of the
  junk rules; a blocked sender lands in junk with the reason, an allowed one is never junk by the rules, and
  every change is audited.

## M8: Privacy, retention and data governance

Execution: M8 issue. It matters most for a practice that works for clients on personal data.

- M8-A1: Each project sets retention periods for tickets, attachments, original mails, translations and records of
  AI runs; a scheduled job removes what is due, in steps, with an audit entry that holds counts and no content.
- M8-A2: A person with the right erases a ticket, or everything about one requester, from the database and the
  storage (messages, attachments, originals, translations, links to issues, portal records and run records); a
  confirmation names what is removed; webhook payloads that left the system are named as out of reach.
- M8-A3: A person with the right exports a project, or what the system holds about one requester, as an archive
  (structured data and files), for a request for information; the export is audited.
- M8-A4: A page and a route list, for each project, which connections and models receive ticket content (mail
  providers, model providers per task, sources of knowledge, webhooks), where they are, and whether a switch or
  an approval is missing; it can be exported for the records of processing.
- M8-A5: `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` can be rotated without losing secrets: a job re-encrypts the
  stored secrets, sessions end where they must, and a failed run leaves the old key valid.

## M9: Notifications and the working place of the operator

Execution: M9 issue.

- M9-A1: Operators receive notifications by mail (and in the desk) for a new ticket in their projects, an
  assignment, a mention in a note, an overdue ticket and a draft of an agent that waits for them; rules are set
  per project, preferences per operator, and a notification never holds more than the subject and a link.
- M9-A2: An operator has a profile (display name, signature, locale, time zone, notification preferences) and
  manages the sign-in methods of their account (password, passkeys and codes, see P8, and the sessions that
  are open, which they can end).
- M9-A3: An operator saves filters of the inbox as views, with a name, and chooses one as the start of the
  work; a view never shows what the filter of the project grants would not.

## Order and dependencies

M6-A3 (audit), M6-A4 (limits) and M6-A2 (providers) first: they are small, they make the others auditable and
they close gaps of M1. M7 follows with M7-A1 and M7-A7 (policies that exist as constants or not at all), then
M7-A2 to A6. M8 starts with M8-A4 (a view over what exists) and M8-A2 and M8-A3 (erasure and export, which each
need the list of what the system holds), then M8-A1 and M8-A5. M9 comes last because it uses the roles and
groups of M6-A6. M6-A7 depends on the domain decision of M3-A2.

## Decisions needed from the product owner

- Retention defaults and who may erase (M8-A1, A2): off by default, only the owner, or per project.
- Whether notifications go out by mail only or also by another channel (M9-A1), and from which connection.
- Which languages beyond English and German a project may use for customers (M6-A7, M7-A5).
- Whether priorities and categories are per project or shared (M7-A3).

## Risks

- Settings that touch the response clock (M7-A2, A3) change what "late" means; the defaults must keep today's
  count, and a test with controlled time has to cover both.
- Erasure and retention (M8) are irreversible; the first version removes in steps with a dry run that lists
  counts, and the tests must prove that nothing of another project or customer goes.
- A setting that routes or blocks mail (M7-A4, A7) can hide a customer's ticket; each has to leave a visible
  trace (unassigned, junk with a reason) and an audit entry.
