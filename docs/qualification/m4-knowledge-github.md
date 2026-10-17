# Qualification of the sources of knowledge and the issues with the real GitHub

Evidence for M4-A3 and M4-A7 of [the completion plan](../plans/m4-completion.md). The fixtures of the
tests use fake servers; this run reads the real ones through the same code as the product
(`searchKnowledge`, `searchIssues`, `linkIssue`, `refreshIssues`, `unlinkIssue`). The script is
[`scripts/qualify-knowledge.ts`](../../scripts/qualify-knowledge.ts). It needs the private development
stack, makes a project of its own and removes it, takes the token from the environment, seals it like the
product does and prints or stores it nowhere. It only reads: nothing is published or changed at GitHub.

```bash
QUALIFY_GITHUB_TOKEN=... QUALIFY_GITHUB_REPOSITORY=owner/name \
  QUALIFY_DOCS_URL=https://docs.hpc.gwdg.de/services/ai-services/saia/index.html \
  pnpm exec tsx scripts/qualify-knowledge.ts out.md
```

Run on the repository `metaneutrons/aidesk` (private, token of the owner, read access) and the page of the
documentation of the Chat AI of the GWDG. The result is below; the times are those of the run.

## Limits

- A first run reported two failures for the documentation checks (the page unavailable, and a timeout where
  `http_404` was expected). The second failure has a cause in the script: the site of the GWDG answers 200
  for a page that is not there (a soft 404), which cannot be told as unavailable. The check now tries the
  address first and, if the site does not answer 404, uses a site that does (`docs.github.com`), or the
  address in `QUALIFY_DOCS_MISSING_URL`. The first failure is not explained with certainty: the page was
  reachable from the container at the same time with a plain request (250 ms), and the run had started
  during a heavy build that used the same machine, so the wait of 8 seconds per request was probably
  exceeded. The second run, without that load, passed. Nothing in the product was changed for it.
- One repository, one page. Sites that need a login, redirect to another host or render their text with
  scripts are not covered (the product refuses a redirect and reads no scripts).
- GitHub Enterprise Server and a customer-context source are not covered: there is no endpoint to run
  against.

## Result

Run on 2026-10-17: 9 of 9 checks passed. The repository and the page are named in the command, the token is not part of this file. Nothing was published or changed at GitHub.

| Group | Check | Expected | Result | Result of the check | Time |
| --- | --- | --- | --- | --- | --- |
| knowledge | the real repository answers with references and times | ok, passages that point into the repository | ok, 3 passage(s), first: https://github.com/metaneutrons/aidesk/issues/160 Issue metaneutrons/aidesk#160 P8: Owner sign-in, recovery of the password and a passkey as second factor (open) | passed | 3392 ms |
| knowledge | a refused token is told as unavailable and nothing is made up | unavailable with a code, no passage | unavailable http_401, 0 passage(s) | passed | 0 ms |
| knowledge | the real documentation page is read and searched by paragraph | ok, a passage with the address of the page | ok, 3 passage(s): SAIA is the Scalable Artificial Intelligence (AI) Accelerator that hosts our AI | passed | 1966 ms |
| knowledge | a page that is not there is told as unavailable | unavailable http_404, no passage | unavailable http_404 | passed | 0 ms |
| issues | a search in the real repository by words | issues or pull requests of the repository with a number and an address | 3 result(s), first: metaneutrons/aidesk#160 P8: Owner sign-in, recovery of the password and a passkey as second factor | passed | 1444 ms |
| issues | linking reads the issue once, and its state is the state at GitHub | linked, the same state as the API of GitHub says | link open "P8: Owner sign-in, recovery of the password and a passkey as second factor", GitHub says open | passed | 3252 ms |
| issues | the refresh reads the state again and keeps the link | refreshed, one link | 1 link(s), refresh error: none | passed | 5653 ms |
| issues | a repository that is not on a connection is refused | refused, nothing linked | not_found, links before 1 and after 1 | passed | 5 ms |
| issues | unlinking removes the link and writes nothing to GitHub | no link left | 0 link(s) left | passed | 7 ms |
