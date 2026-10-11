# aidesk

A shared support desk for solo developers and small teams supporting multiple
projects, with project-specific email, private customer portals and governed
AI control through HTTPS MCP and direct API.

Start with the [implementation epic](https://github.com/metaneutrons/aidesk/issues/1) and its five milestone
issues. The [initial product plan](docs/plans/initial-product.md) defines agreed scope,
design decisions, delivery dependencies and acceptance criteria. The
[UX concept](docs/design/ux.md) describes the dashboard, shared filtered inbox,
customer portals and multilingual communication. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the planning convention.

The first development slice includes a persisted dashboard and filtered inbox,
English/German UI, private notes, a durable SMTP outbox, styled HTML/text mail,
project permissions and authenticated REST/MCP entry points. The complete product
and production deployments are still being implemented; milestone issues track
the remaining qualification.

## Local development

Install Docker with Compose v2 and OpenSSL, then run:

```sh
sh scripts/dev.sh up --build -d
```

Open `http://localhost:3000`. The local owner is `owner@aidesk.local`; read its
generated password from `.env.development` on your own machine. Keep that file
and `.local/s3.json` private. Mailpit captures outgoing mail at
`http://localhost:8025`, without an external relay. PostgreSQL, private S3 storage
and dependency caches use named volumes. PostgreSQL is reachable only inside the
Compose network; it is not published to the host. Editing `src/` reloads the app.

```sh
sh scripts/dev.sh exec -T app pnpm lint
sh scripts/dev.sh exec -T app pnpm typecheck
sh scripts/dev.sh exec -T app pnpm check:catalogs
sh scripts/dev.sh exec -T app pnpm test --coverage
sh scripts/dev.sh exec -T -e NODE_ENV=production -e NEXT_DIST_DIR=.next-production app pnpm build
sh scripts/dev.sh down
```

Stopping the stack preserves data. Integration tests use `aidesk_test`, separate
from the development desk. The bootstrap creates two persisted example projects
once and preserves later configuration. Generated credentials are for private
development; this Compose file is not a production deployment.

For host tooling use Node 26 and the package's pinned standalone pnpm, then `pnpm
install --frozen-lockfile`. Lefthook installs the Git hooks; install Gitleaks
before committing or pushing. Without a host `DATABASE_URL`, the pre-push hook
runs the tests inside the running app container. If the host creates or replaces
`node_modules` while the stack runs, recreate the containers with `sh
scripts/dev.sh up -d --force-recreate app worker`. Some bind-mount implementations
(observed with Lima/virtiofs on Apple Silicon) then detach the container's
dependency volume and expose host-platform packages; the pre-push hook detects
this and stops. CI runs only on Node 26. See the [development
handoff](docs/development.md) for configuration, evidence and gaps. For the move
from cloud to a local machine, use the [local implementation
handoff](docs/handoff-local.md), including a continuation prompt for the next
agent.
