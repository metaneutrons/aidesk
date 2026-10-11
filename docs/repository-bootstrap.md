# Repository bootstrap status

The supplied gitrepo skill was read from `metaneutrons/claude-skills` at commit
`6e0b80ecd064572cf44b066b356b49dfdfad398a`. Its TypeScript ESLint, Lefthook,
hook scripts, editorconfig, ignore and CI templates form this foundation.
The staged ESLint hook suppresses notices for intentionally ignored generated
declaration files; actual lint warnings/errors still fail at zero warnings.
The explicit user override is Node 26 only in CI. Repository prose is English;
German catalogues and multilingual fixtures are intentional product content.
The application uses the skill's GPL-3.0-or-later default. No Vellum code or
assets were copied; its access/design architecture was a reference.

Pinned pnpm, frozen installation, strict typed ESLint, strict TypeScript 6.0,
coverage thresholds, positive/counter gate probes, Conventional Commits,
Gitleaks, community files and SHA-pinned Actions are present. The current API/MCP
differences are explicit in `docs/capabilities.md`. Production release hardening
and publication channels are not yet qualified; no release workflow publishes
an image, package or application from this slice.

## Blocked administration changes

On 2026-10-11 the GitHub API returned HTTP 403 "Resource not accessible by
integration" for repository settings, topics, secret scanning/push protection,
private vulnerability reporting, vulnerability alerts, automated security fixes
and branch/tag rulesets. User-level `permissions.admin=true` in repository
metadata does not grant those operations to the connected GitHub App.
Private vulnerability reporting was separately read back as disabled. Default
branch protection was absent; no ruleset mutation succeeded.

The reviewable intended configuration is in `config/github/`. Apply it only with
a GitHub connection authorized for administration and the corresponding security
features. Preserve existing protection if the repository changes meanwhile.
Enable vulnerability alerts before automated security fixes. The branch ruleset
intentionally has no required status yet: the skill requires taking the exact
aggregate name from a real run before binding it. It uses zero approval votes
for a solo-maintained repository, resolved discussions and squash-only history.
Immutable `v*` tags are planned without creating or publishing a tag.

After an actual successful CI run, add its observed aggregate check to the branch
ruleset and read back every setting/rule. Until these operations and release
qualification pass, M5-A4 and the full gitrepo bootstrap remain open.
