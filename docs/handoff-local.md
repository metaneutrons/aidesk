# Local implementation handoff

Prepared on 2026-10-11. Continue from the existing implementation, not from the
documentation-only `main` branch. No merge or release is needed to work locally.

## Source and authority

- Repository: <https://github.com/metaneutrons/aidesk>.
- Working branch: `feat/docker-development-foundation`.
- Open draft: [PR #7](https://github.com/metaneutrons/aidesk/pull/7).
- Qualified application baseline: `daf76d2f2e60eed5c5fc5011fb73881a3a6d305d`.
  This handoff is a subsequent documentation change on the same branch.
- [Successful baseline CI](https://github.com/metaneutrons/aidesk/actions/runs/38161414225).
- [Product plan](plans/initial-product.md) owns requirements and acceptance;
  [UX concept](design/ux.md) owns interaction examples. The plan authority linked
  by the issues is revision `b0393ba566708af393fca45883f0052ddb3d9821`.
- [Epic #1](https://github.com/metaneutrons/aidesk/issues/1) and milestones
  [M1 #2](https://github.com/metaneutrons/aidesk/issues/2),
  [M2 #3](https://github.com/metaneutrons/aidesk/issues/3),
  [M3 #4](https://github.com/metaneutrons/aidesk/issues/4),
  [M4 #5](https://github.com/metaneutrons/aidesk/issues/5), and
  [M5 #6](https://github.com/metaneutrons/aidesk/issues/6) own execution evidence.
  All remain open; checked execution steps are not whole-milestone acceptance.

## First local start

Install Git, Docker with Compose v2, and OpenSSL. Start Docker before these
commands. For a new checkout:

```sh
mkdir -p ~/Source
cd ~/Source
git clone --branch feat/docker-development-foundation https://github.com/metaneutrons/aidesk.git
cd aidesk
sh scripts/dev.sh up --build -d
```

If `~/Source/aidesk` already exists, preserve its changes and inspect its branch
before fetching/checking out the implementation branch. Do not reset or overwrite
an existing checkout. Local development does not require publishing the cloud
environment draft or copying any cloud proxy/CA variables.

| Service                  | Local address           |
| ------------------------ | ----------------------- |
| App                      | `http://localhost:3000` |
| Mailpit HTML/text viewer | `http://localhost:8025` |
| S3-compatible storage    | `http://localhost:8333` |
| Development SMTP         | `127.0.0.1:1025`        |

PostgreSQL stays inside the Compose network and is not published to the host, so a
host database on port 5432 does not collide. These ports must be free. If there is
a collision, inspect the existing service before changing bindings. Changing the
app's public origin also requires matching `APP_URL`; authentication and
mutation-origin checks depend on it.

The owner email is `owner@aidesk.local`. Read `DEV_OWNER_PASSWORD` in your local
`.env.development` using your editor. The bootstrap generates private credentials,
applies migrations, creates a separate `aidesk_test` database, and seeds Orbit and
Harbor once. Existing project configuration is preserved on subsequent starts.

```sh
sh scripts/dev.sh ps
curl --fail http://localhost:3000/api/health/ready
```

Wait for app readiness; the initial framework build can take time. Sign in, open
an example ticket, save a private note and send a public reply. Mailpit should
show the styled HTML and text reply; the private note must not appear in mail.
The response clock completes after transport acceptance, not merely queueing.

Source edits reload the Next.js app. Worker changes require
`sh scripts/dev.sh restart worker`. After dependency changes, rerun the build/start
command so the boot script updates the shared dependency volume.

```sh
sh scripts/dev.sh down
sh scripts/dev.sh up -d
```

Normal stop/start retains PostgreSQL and S3 data. `down -v` deletes named volumes
and is not a normal stop command. Mailpit's captured messages are ephemeral in
the current Compose setup.

## What moves, and what stays in the cloud

Git transfers code, migrations, plans and documentation. It does not transfer
Docker volumes, `.env.development`, `.local/s3.json`, browser drafts or cloud
research scripts/logs. The documented local start creates a fresh database and
new credentials; it does not import the cloud's example conversations.

The cloud's observed data consists of development fixtures and smoke-test
replies. No customer mailbox/provider data was imported. An intentional database
transfer would also require its matching encryption key, private object storage
and connection credentials. Do not import encrypted database configuration with
newly generated keys. No data transfer is performed by this handoff.

## Checks and host Git tooling

Application commands run inside Docker on Node 26 with pinned pnpm 11.25.0:

```sh
sh scripts/dev.sh exec -T app pnpm format:check
sh scripts/dev.sh exec -T app pnpm lint
sh scripts/dev.sh exec -T app pnpm typecheck
sh scripts/dev.sh exec -T app pnpm check:catalogs
sh scripts/dev.sh exec -T app pnpm test --coverage
sh scripts/dev.sh exec -T -e NODE_ENV=production -e NEXT_DIST_DIR=.next-production app pnpm build
sh scripts/dev.sh exec -T app pnpm check:gates
```

Run `check:gates` after the other commands, without overlapping a build or other
checks: it temporarily creates deliberately invalid sources and verifies gate
rejection. Tests use `aidesk_test`, separate from the desk database. The 90%
coverage floor covers domain/server code; worker orchestration is excluded and
still needs complete failure/race qualification.

For host commits/pushes, install Node 26, standalone pnpm 11.25.0 and Gitleaks.
With the correct Node version active:

```sh
node --version
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
gitleaks version
```

The container dependency volume does not install host dependencies. Host install
prepares Lefthook for host Git commands; the development containers skip hook
installation because they share the host's `.git`. If the host creates or replaces
`node_modules` while the stack runs, recreate the containers with `sh
scripts/dev.sh up -d --force-recreate app worker`. Some bind-mount implementations
(observed with Lima/virtiofs on Apple Silicon) then detach the container's
dependency volume and expose host-platform packages; the pre-push hook detects
this and stops. Do not bypass hooks to work around a missing host tool. CI runs
only on Node 26; Corepack is not the setup path. Use English repository prose and
Conventional Commits, preserving user changes.

Apply the user-requested gitrepo skill from
`metaneutrons/claude-skills`, revision
`6e0b80ecd064572cf44b066b356b49dfdfad398a`, file `gitrepo/SKILL.md`.
If the skill is not already installed locally, obtain that exact revision in a
separate checkout and read it before further implementation. Cloud-only helper
paths under `/workspace/shared` are not local prerequisites. The explicit user
override remains pnpm and Node-26-only CI. Full gitrepo qualification remains
open as described in [repository bootstrap status](repository-bootstrap.md).

## Implemented boundaries and remaining work

The current app has persisted projects/grants, a dashboard and filtered shared
inbox, English/German operator locale, Markdown conversations, per-ticket browser
drafts, project creation, private notes and durable same-language SMTP replies.
REST `/api/v1` and Streamable HTTP MCP `/api/mcp` share operations and enforce
project/action scope. The local MCP URL uses HTTP; remote HTTPS is unqualified.
Agent-token provisioning UI and full authorized configuration management remain.

PostgreSQL persists domain/configuration/jobs/audit/identity data. S3 holds private
blobs when those capabilities are implemented. Connection secrets and SSO
configuration have encryption boundaries; daily project configuration belongs in
the app, while deployment root keys remain environment configuration. See
[development details](development.md) and [capability differences](capabilities.md).

Still open: real OIDC/SAML/recovery/MFA, inbound Cloudflare/IMAP and all provider
mixes, acknowledgements, portal links/custom domains, original HTML preview,
junk/extraction, editable project email design, AI translations, named agent
assignment/runners, knowledge/GitHub, escalations, full settings and complete
pagination/dashboard aggregates. The current list is limited to 250 tickets.
Vercel and hardened production Docker, backups/recovery, retention/export and
deletion are also unqualified. Installed SDKs/schema fields are not working
integrations.

## Next local work

1. Reproduce Docker readiness and the browser/mail workflow above on the actual
   local machine. Record OS/architecture, source SHA and outcomes in the issues.
   The pinned image indexes contain both amd64 and arm64, verified from registry
   metadata; the cloud runtime was Linux amd64. Apple Silicon execution and
   Linux hosts with a different source-file UID remain untested.
2. Establish real Playwright configuration and browser tests for login, authorized
   project filtering, notes/replies, locale/theme, drafts and keyboard/focus
   behavior. Playwright is installed, but no E2E suite is delivered yet. Observe
   actual UI workflows before claiming accessibility or enterprise UX.
3. Complete M1's real OIDC/SAML and owner provisioning/recovery path, plus a
   selected authenticated remote HTTPS MCP client. Preserve explicit project
   grants; owner status must not silently bypass project access.
4. Continue M2's durable mail input and independent inbound/outbound adapters.
   Use the plan's four email pairings and optional automatic input-pipeline AI
   stages. Keep canonical Markdown separate from themed HTML/original mail and
   translation derivatives. Extend shared UI/REST/MCP capabilities with explicit
   differences and evidence rather than creating separate policy implementations.
5. Continue the linked milestones. After successful steps, update their execution
   records with exact code/input/run references. Close a milestone/epic only when
   all applicable mandatory criteria and dependencies are qualified.

GitHub settings/security/ruleset writes returned upstream integration HTTP 403.
Prepared JSON is in `config/github`; no administration mutation succeeded.
`CI Success` is an observed passing check, but the protection draft is not active.
Use an appropriately authorized local GitHub connection for applying/readback;
do not treat user-level admin metadata as proof of integration permissions.

Cloud browser downloads returned policy HTTP 403. A narrow CDN allowance and
updated setup are saved in cloud draft revision 21 but not published. These are
cloud constraints, not a requirement for ordinary local Docker. The cloud also
had transient npm/GitHub HTTP 503 and limited disk; distinguish failures before
changing configuration. No browser/accessibility or fresh-cloud-restore evidence
exists. Silo's identity/role is still unresolved; request its URL/description
before assuming an integration.

## Prompt for the next local agent

```text
Continue aidesk in this checkout using docs/handoff-local.md. Respond in German.
Read the product plan, UX concept, development/capability/bootstrap documents,
and current epic #1/milestone issues #2–#6. Apply the supplied gitrepo skill at
the revision named in the handoff. Use pnpm and Node 26; CI is Node 26 only.
Preserve existing changes, private config and data. Start from the existing
implementation branch/PR #7; do not rebuild the product from scratch or reset
to the documentation-only baseline.
First reproduce the Docker/browser/Mailpit workflow and record the actual local
platform. Establish meaningful browser tests and finish M1's remaining identity,
recovery and remote HTTPS MCP qualification, then continue the planned mail/core
milestones. Use shared authorization/domain operations for UI, REST and MCP.
Mark successful execution steps with exact evidence; leave incomplete milestones
and epic open. Do not claim real providers, accessibility or production deployment
based only on installed libraries, fixtures or development builds. Clarify Silo's
URL/role when available. Continue authorized implementation without repeated
confirmation requests; no merge, release or production publication is authorized
by this handoff alone.
```
