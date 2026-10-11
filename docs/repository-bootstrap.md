# Repository bootstrap status

The gitrepo skill from `metaneutrons/claude-skills` was first applied at commit
`6e0b80ecd064572cf44b066b356b49dfdfad398a` and updated on 2026-10-11 to
`160504750456c32ec87821ddd4917e91960f09b8`, which replaces the pre-commit lockfile
guard with a pnpm frozen-lockfile check of the staged manifests. Its TypeScript
ESLint, Lefthook, hook scripts, editorconfig, ignore and CI templates form this
foundation. `lefthook.yml` deviates from the template in two marked places: the
staged ESLint hook suppresses notices for intentionally ignored generated
declaration files (actual lint warnings/errors still fail at zero warnings), and
the pre-push test command runs `scripts/hooks/run-tests.sh`, which uses the app
container because the development database is not published to the host. The
explicit user override is Node 26 only in CI. Repository prose is English; German
catalogues and multilingual fixtures are intentional product content. The
application uses the skill's GPL-3.0-or-later default. No Vellum code or assets
were copied; its access/design architecture was a reference.

Pinned pnpm, frozen installation, strict typed ESLint, strict TypeScript 6.0,
coverage thresholds, positive/counter gate probes, Conventional Commits,
Gitleaks, community files and SHA-pinned Actions are present. The current API/MCP
differences are explicit in `docs/capabilities.md`. Production release hardening
and publication channels are not yet qualified; no release workflow publishes
an image, package or application from this slice.

## Administration changes

In the cloud environment on 2026-10-11 the GitHub API returned HTTP 403
"Resource not accessible by integration" for every administration write.

On 2026-10-11 the reviewed configuration in `config/github/` was applied from
an authorized local connection: repository settings (squash only with
`PR_TITLE`/`PR_BODY`, auto-merge allowed, branch deletion on merge), topics,
secret scanning with push protection, private vulnerability reporting,
vulnerability alerts followed by automated security fixes, the default-branch
ruleset and the immutable `v*` tag ruleset. The default-branch ruleset requires
`CI Success`, the aggregate name observed in the successful
[Node 26 CI run](https://github.com/metaneutrons/aidesk/actions/runs/38160850493)
on commit `2329abacc9188397abab7110da3587bd2371b608`, with zero approval votes
for a solo-maintained repository, resolved discussions, linear history and
squash-only merges. No tag was created.

Read-back with the gitrepo `check-gitrepo.sh` passed every settings, security and
ruleset check. Non-provider secret patterns are unavailable for a user account.
The required-check test first failed because `main` had no CI run yet; after the
first application merges it passed as well (17 passed, 0 failed, 2 notes on
2026-10-11). M5-A4 and the full gitrepo bootstrap stay open until release
qualification is done.
