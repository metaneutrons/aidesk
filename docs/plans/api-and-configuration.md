# Initiative plan: API definition and AI-editable configuration

Epic: [#68](https://github.com/metaneutrons/aidesk/issues/68).
Decision state: accepted 2026-10-13 by the product owner in chat: the REST API
publishes a machine-readable definition, every configuration and template of
every project is reachable through it, and AI changes are drafts that a human
activates by default, switchable per project to direct application.
Repository location: `docs/plans/api-and-configuration.md`.
This versioned plan owns requirements; linked issues own execution and evidence.
It refines the API and project-configuration parts of
[the initial product plan](initial-product.md) (M3 settings, M4 direct API and
MCP parity) and does not replace its acceptance criteria.

## Outcome and boundaries

An operator or an AI agent can read and change everything that configures a
project through the REST API and MCP, guided by a published API definition,
without the web interface and without a way around the project's approval rule.

Measured baseline on 2026-10-13 (from `main`):

- The REST API is a hand-written catch-all router in
  `src/app/api/v1/[[...path]]/route.ts`. Each operation validates its own input.
  No API definition exists.
- Configuration over REST: create a project, two settings
  (`acknowledgements`, `portalLinks`), email designs, agent tokens, operators and
  grants. `setProjectSettings` refuses agent principals.
- Not reachable over REST: project master data (name, colour, default language,
  portal domain), connections (IMAP, SMTP, Cloudflare, SMTP2GO; today only the
  development bootstrap writes them), the texts that live in code (acknowledgement,
  portal, mail strings), the response-clock thresholds (4 and 24 hours, constants),
  and AI or translation profiles (M4).
- MCP offers `projects_list`, `tickets_list`, `tickets_search`, `tickets_get` and
  `tickets_reply`. It offers no configuration.

Included: a route table as single source for router, API definition and MCP
tools; configuration permissions; validation without writing; versions and
concurrency control; change proposals with a per-project approval policy; a
configuration document per project; connections with write-only secrets; texts as
versioned templates per project and language; REST gaps for ticket work
(status, assignment, notes, attachments).

Not included: instance-level identity configuration (SSO providers, operators,
recovery), which stays with humans; AI and translation profiles themselves
(M4 owns them, this plan only makes them fit the same mechanism); a hosted API
explorer; client SDK generation; webhooks (open question below).

## Design and decisions

**Route table.** One typed table lists every route with method, path, input and
output schema (zod), the required action and the domain operation. The router
dispatches from it, the API definition (OpenAPI 3.1, served at
`/api/v1/openapi.json`) is generated from it, and MCP tools are derived from the
same entries where a tool is offered. The capability registry
(`src/domain/capabilities.ts`) is extended, not replaced. The migration is
route by route; the catch-all router and the table coexist until the last route
moved. Alternative considered: describing the existing routes by hand in an
OpenAPI file. Rejected because it drifts silently; a generated document cannot.

**Permissions.** New actions `config.read`, `config.write` and `config.approve`
for project configuration; connections stay under `integration.manage`.
`agent.manage`, `config.approve` and instance-level operations are never
grantable to an agent. An agent that answers customers does not receive
configuration rights by default, because customer text must not be able to steer
configuration (prompt injection).

**Approval policy.** Each project has `approvalPolicy`: `review` (default) or
`direct`.

- `review`: a configuration write by an agent creates a change proposal and
  returns `202` with the proposal. A human with `config.approve` activates or
  rejects it. Writes by humans apply directly.
- `direct`: a write by an agent applies at once. It is still validated, versioned,
  audited and revertible.
- Only a human with `config.approve` changes the policy.
- The policy governs configuration and templates. Customer replies stay under the
  existing `aiMode` and `ticket.reply`; whether both become one switch is an
  open question.

Strongest objection: review mode slows exactly the workflow that is wanted.
Answer: it is the default the owner chose, `direct` is one setting away per
project, and versions plus audit make a direct change revertible either way.

**Safe writing.** Every write supports validation without effect
(`?validate=true`, returns the diff and field errors), requires the version
being changed (`If-Match` / `expectedVersion`) and accepts an idempotency key.
Errors follow RFC 9457 with a stable code and the pointer of the offending field.
Secrets are write-only: set, replace or clear, never returned, never in a diff,
never in the audit detail.

**Configuration document.** `GET` and `PUT /projects/:id/config` read and replace
the whole non-secret configuration of a project as one validated document with
diff preview. Per-object routes remain for the web interface. The document is the
unit of a proposal.

**Existing designs.** Email designs are already versioned with an active pointer.
They keep their model; proposals and the policy are applied to the activation of a
version, and the design routes move to the route table.

## Delivery and acceptance

### C1: API definition from a route table

Execution: [C1 #69](https://github.com/metaneutrons/aidesk/issues/69).
Dependencies: none.
Outcome: one source for routes, schemas, permissions and the published definition.

- C1-A1: `GET /api/v1/openapi.json` returns a valid OpenAPI 3.1 document for every
  route that has moved to the table, with request and response schemas, security
  schemes (agent token, session) and the required action per operation. A
  validator accepts it; a deliberately invalid copy is rejected.
- C1-A2: A test fails when a route exists without a table entry or a table entry
  lacks an input or output schema, in both directions, and when the generated
  document changes without the committed snapshot.
- C1-A3: Router behaviour is unchanged for every moved route: the existing unit,
  end-to-end and capability tests pass without edits to their expectations;
  unknown paths and wrong methods still return the same errors.
- C1-A4: The routes moved in the first delivery are listed in the development
  documentation together with those that still use the old router.

### C2: Configuration core

Execution: [C2 #70](https://github.com/metaneutrons/aidesk/issues/70).
Dependencies: C1.
Outcome: safe, versioned, permissioned configuration writes with the approval policy.

- C2-A1: The new actions exist; an agent cannot be granted `config.approve` or
  `agent.manage`; a read-only token cannot read configuration it was not granted.
- C2-A2: `?validate=true` returns diff and errors without changing state;
  a stale version is refused with a conflict; a repeated idempotency key does not
  apply twice.
- C2-A3: With `review`, an agent write returns a proposal, nothing changes until a
  human activates it, a rejected or superseded proposal never applies, and a
  proposal on a stale base is refused at activation. With `direct`, the same write
  applies and is audited. Switching the policy needs `config.approve` and is
  audited. Counter-probes cover an agent trying to activate its own proposal.
- C2-A4: Project master data and all existing settings are readable and writable
  through the table, and the configuration document round-trips (read, validate,
  put) without loss.
- C2-A5: Errors carry stable codes and field pointers; secrets appear in no
  response, diff, audit entry or log.

### C3: Connections and texts

Execution: [C3 #71](https://github.com/metaneutrons/aidesk/issues/71).
Dependencies: C2.
Outcome: the remaining configuration reachable through the same mechanism.

- C3-A1: Connections of every implemented kind can be created, changed, tested and
  disabled through REST under `integration.manage` and the approval policy;
  secrets are write-only; a failed test leaves the status Degraded with a code and
  no secret.
- C3-A2: The acknowledgement text, portal texts and mail strings are versioned
  templates per project and language with placeholders validated on write; the
  built-in German and English texts are the defaults, and a missing translation
  falls back to them.
- C3-A3: The overdue limit of the response clock is a project setting with the
  current value (24 hours) as default and is used by the overview and the list.
- C3-A4: The web interface shows the same configuration it can write and records
  the difference to REST in the ledger where one remains.

### C4: Parity and the remaining gaps

Execution: [C4 #72](https://github.com/metaneutrons/aidesk/issues/72).
Dependencies: C1, C2.
Outcome: MCP and REST cover the same operations; ticket work is complete over REST.

- C4-A1: MCP tools for configuration are derived from the table; the parity test
  fails when an operation is offered by one surface and not declared for the other.
- C4-A2: Ticket status, assignment, notes and attachments are available over REST
  and MCP under their existing actions.
- C4-A3: Contract tests generated from the published definition run in CI against
  the running application, with a probe that a changed response shape fails them.
- C4-A4: The definition and a short guide for agents (what to read first, how
  validation, proposals and versions work) are published with the application.

## Migration, risks and verification cost

Adoption is incremental: C1 changes no behaviour. Configuration writes by agents
are new, so no existing agent loses a right; `review` is the default for existing
and new projects. Rollback of C1 is reverting the router change; rollback of C2 and
C3 is disabling the new actions, which leaves human paths intact.

Risks: a configuration document that grows into a second source of truth beside
the per-object routes (mitigated by generating both from the same schemas); a
proposal model that duplicates the design versioning (mitigated by applying it to
activation only); secrets leaking through diffs (tested explicitly).

Verification: focused unit and end-to-end tests per delivery; the full browser
matrix only when the web interface changes.

Open questions:

- Does the approval policy also cover customer replies, merging `aiMode` into one
  switch?
- Is an instance-wide default for new projects needed, or is the per-project value
  enough?
- Are outbound webhooks for ticket events in scope for C4 or a later initiative?
- Where does the AI-profile configuration of M4 enter the configuration document?

## Decision changes

2026-10-13: plan created; approval default and per-project switch decided by the
product owner.

2026-10-13: C3-A3 corrected before acceptance. The customer page shows no response
timing, so the portal is not a place where the limit is used, and the warning limit
(4 hours) is shown nowhere, so only the overdue limit becomes a setting. Evidence:
the PR that made `overdueHours` a project setting. The criterion text is the only
change; no acceptance was recorded against the earlier wording.
