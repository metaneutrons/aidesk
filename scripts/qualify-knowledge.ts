// Qualification of the sources of knowledge and of the issues against the real GitHub and a real
// documentation site (M4-A3, M4-A7): the fixtures of the tests use fake servers, this reads the real ones.
//
//   QUALIFY_GITHUB_TOKEN=<token that may read the repository> QUALIFY_GITHUB_REPOSITORY=owner/name \
//     QUALIFY_DOCS_URL=<address of a page> pnpm exec tsx scripts/qualify-knowledge.ts [out.md]
//
// It needs the private development stack, makes its own project under `qualify-` and removes it, reads the token
// from the environment, seals it like the product does and never prints or writes it. It only reads: nothing is
// published or changed at GitHub.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { eq, inArray, like } from "drizzle-orm";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  connections,
  memberships,
  projects,
  ticketIssues,
  tickets,
  user,
} from "../src/server/db/schema";
import { actions, type Principal } from "../src/domain/permissions";
import { clearKnowledgeCache, searchKnowledge } from "../src/server/knowledge";
import { linkIssue, refreshIssues, searchIssues, unlinkIssue } from "../src/server/issues";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
const token = process.env.QUALIFY_GITHUB_TOKEN ?? "";
const repository = process.env.QUALIFY_GITHUB_REPOSITORY ?? "";
const docsUrl = process.env.QUALIFY_DOCS_URL ?? "";
if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !docsUrl)
  throw new Error("Set QUALIFY_GITHUB_TOKEN, QUALIFY_GITHUB_REPOSITORY and QUALIFY_DOCS_URL.");
if (process.env.DEV_BOOTSTRAP !== "true" || process.env.NODE_ENV !== "development")
  throw new Error("The qualification runs on the private development stack only.");
const projectId = randomUUID();
const me: Principal = {
  id: "qualify-knowledge",
  kind: "human",
  active: true,
  owner: true,
  grants: [{ projectId, actions: [...actions] }],
};
const redact = (text: string) => text.split(token).join("[token]");
const one = (text: string, limit = 300) => redact(text).replace(/\s+/g, " ").trim().slice(0, limit);
interface Row {
  group: string;
  name: string;
  expected: string;
  got: string;
  pass: boolean;
  took: number;
}
const rows: Row[] = [];
async function record(
  group: string,
  name: string,
  expected: string,
  run: () => Promise<{ got: string; pass: boolean }> | { got: string; pass: boolean },
) {
  const started = Date.now();
  let result: { got: string; pass: boolean };
  try {
    result = await run();
  } catch (error) {
    result = {
      got: `error: ${error instanceof Error ? error.message : String(error)}`,
      pass: false,
    };
  }
  rows.push({
    group,
    name,
    expected,
    got: one(result.got),
    pass: result.pass,
    took: Date.now() - started,
  });
  console.log(`${result.pass ? "ok  " : "FAIL"} ${group} / ${name}: ${one(result.got, 100)}`);
}
async function source(
  kind: "github" | "docs",
  name: string,
  config: Record<string, unknown>,
  secret: Record<string, unknown> | null,
) {
  const [row] = await db()
    .insert(connections)
    .values({
      projectId,
      kind,
      direction: "knowledge",
      name,
      status: "ready",
      config,
      secretCiphertext: secret ? seal(JSON.stringify(secret), env().ENCRYPTION_KEY) : null,
    })
    .returning({ id: connections.id });
  return row?.id ?? "";
}
async function wipe() {
  const found = await db()
    .select({ id: projects.id })
    .from(projects)
    .where(like(projects.slug, "qualify-%"));
  const ids = found.map((row) => row.id);
  if (ids.length) {
    await db().delete(audit).where(inArray(audit.projectId, ids));
    await db().delete(tickets).where(inArray(tickets.projectId, ids));
    await db().delete(connections).where(inArray(connections.projectId, ids));
    await db().delete(memberships).where(inArray(memberships.projectId, ids));
    await db().delete(projects).where(inArray(projects.id, ids));
  }
  await db().delete(user).where(eq(user.id, me.id));
}
const github = (path: string) =>
  fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
async function main() {
  await wipe();
  await db()
    .insert(projects)
    .values({ id: projectId, name: "Qualification of knowledge", slug: `qualify-${projectId}` });
  await db().insert(user).values({
    id: me.id,
    name: "Qualification",
    email: "qualify-knowledge@example.test",
    emailVerified: true,
  });
  await db()
    .insert(memberships)
    .values({ userId: me.id, projectId, actions: [...actions] });
  const [created] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Where do I find the API key?",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      pendingSince: new Date(Date.now() - 3_600_000),
    })
    .returning({ id: tickets.id });
  const ticketId = created?.id ?? "";
  const real = await source("github", "Real repository", { repositories: [repository] }, { token });
  const wrong = await source(
    "github",
    "Refused token",
    { repositories: [repository] },
    { token: "ghp_this_token_does_not_exist_0000000000000000" },
  );
  const page = await source(
    "docs",
    "Real documentation",
    { pages: [{ title: "Documentation", url: docsUrl }] },
    null,
  );
  // Many documentation sites answer 200 for a page that is not there (a soft 404), and a status of 200
  // cannot be told as unavailable. So the address of the page is tried first; if the site does not answer
  // 404 for it, a site that does is used for this one check.
  const gone = `${docsUrl.replace(/[#?].*$/, "")}-does-not-exist-${randomUUID().slice(0, 6)}`;
  const goneStatus = await fetch(gone, { redirect: "manual" }).then(
    (response) => response.status,
    () => 0,
  );
  const missingUrl =
    process.env.QUALIFY_DOCS_MISSING_URL ??
    (goneStatus === 404
      ? gone
      : `https://docs.github.com/en/does-not-exist-${randomUUID().slice(0, 6)}`);
  console.log(
    `missing page: ${new URL(gone).hostname} answers ${String(goneStatus)}, checked at ${new URL(missingUrl).hostname}`,
  );
  const missing = await source(
    "docs",
    "A page that is not there",
    { pages: [{ title: "Gone", url: missingUrl }] },
    null,
  );
  const state = (answer: Awaited<ReturnType<typeof searchKnowledge>>, id: string) =>
    answer.sources.find((entry) => entry.connectionId === id);
  const passages = (answer: Awaited<ReturnType<typeof searchKnowledge>>, id: string) =>
    answer.passages.filter((entry) => entry.connectionId === id);
  clearKnowledgeCache();
  let knowledge: Awaited<ReturnType<typeof searchKnowledge>> | undefined;
  await record(
    "knowledge",
    "the real repository answers with references and times",
    "ok, passages that point into the repository",
    async () => {
      knowledge = await searchKnowledge(me, ticketId, "owner password recovery passkey");
      const own = passages(knowledge, real);
      const entry = state(knowledge, real);
      return {
        got: `${entry?.state ?? "?"}, ${String(own.length)} passage(s), first: ${own[0]?.reference ?? "-"} ${own[0]?.title ?? ""}`,
        pass:
          entry?.state === "ok" &&
          own.length > 0 &&
          own.every(
            (passage) =>
              passage.reference.startsWith(`https://github.com/${repository}/`) &&
              passage.text.length > 0 &&
              !Number.isNaN(Date.parse(passage.fetchedAt)),
          ),
      };
    },
  );
  await record(
    "knowledge",
    "a refused token is told as unavailable and nothing is made up",
    "unavailable with a code, no passage",
    () => {
      if (!knowledge) throw new Error("no answer");
      const entry = state(knowledge, wrong);
      return {
        got: `${entry?.state ?? "?"} ${entry?.error ?? ""}, ${String(passages(knowledge, wrong).length)} passage(s)`,
        pass:
          entry?.state === "unavailable" &&
          /^http_40[13]$/.test(entry.error ?? "") &&
          passages(knowledge, wrong).length === 0,
      };
    },
  );
  await record(
    "knowledge",
    "the real documentation page is read and searched by paragraph",
    "ok, a passage with the address of the page",
    async () => {
      knowledge = await searchKnowledge(me, ticketId, "API key");
      const own = passages(knowledge, page);
      const entry = state(knowledge, page);
      return {
        got: `${entry?.state ?? "?"}, ${String(own.length)} passage(s): ${own[0]?.text.slice(0, 80) ?? "-"}`,
        pass:
          entry?.state === "ok" &&
          own.length > 0 &&
          own.every((passage) => passage.reference.startsWith(docsUrl.split("#")[0] ?? docsUrl)),
      };
    },
  );
  await record(
    "knowledge",
    "a page that is not there is told as unavailable",
    "unavailable http_404, no passage",
    () => {
      if (!knowledge) throw new Error("no answer");
      const entry = state(knowledge, missing);
      return {
        got: `${entry?.state ?? "?"} ${entry?.error ?? ""}`,
        pass:
          entry?.state === "unavailable" &&
          entry.error === "http_404" &&
          passages(knowledge, missing).length === 0,
      };
    },
  );
  let issue: { repository: string; number: number } | undefined;
  await record(
    "issues",
    "a search in the real repository by words",
    "issues or pull requests of the repository with a number and an address",
    async () => {
      const found = await searchIssues(me, ticketId, "passkey owner");
      const first = found.issues[0];
      if (first) issue = { repository: first.repository, number: first.number };
      return {
        got: `${String(found.issues.length)} result(s), first: ${first ? `${first.repository}#${String(first.number)} ${first.title}` : "-"}`,
        pass:
          found.issues.length > 0 &&
          found.issues.every(
            (entry) =>
              entry.repository === repository &&
              entry.number > 0 &&
              entry.url.startsWith(`https://github.com/${repository}/`),
          ),
      };
    },
  );
  await record(
    "issues",
    "linking reads the issue once, and its state is the state at GitHub",
    "linked, the same state as the API of GitHub says",
    async () => {
      if (!issue) throw new Error("no issue found");
      const linked = await linkIssue(me, ticketId, issue);
      const truth = (await (
        await github(`/repos/${issue.repository}/issues/${String(issue.number)}`)
      ).json()) as { state: string; title: string };
      const [row] = await db()
        .select()
        .from(ticketIssues)
        .where(eq(ticketIssues.ticketId, ticketId));
      return {
        got: `link ${row?.state ?? "?"} "${row?.title ?? ""}", GitHub says ${truth.state}`,
        pass: Boolean(linked) && row?.state === truth.state && row.title === truth.title,
      };
    },
  );
  await record(
    "issues",
    "the refresh reads the state again and keeps the link",
    "refreshed, one link",
    async () => {
      await refreshIssues(me, ticketId);
      const links = await db()
        .select()
        .from(ticketIssues)
        .where(eq(ticketIssues.ticketId, ticketId));
      return {
        got: `${String(links.length)} link(s), refresh error: ${links[0]?.refreshError ?? "none"}`,
        pass: links.length === 1 && !links[0]?.refreshError,
      };
    },
  );
  await record(
    "issues",
    "a repository that is not on a connection is refused",
    "refused, nothing linked",
    async () => {
      const before = (
        await db().select().from(ticketIssues).where(eq(ticketIssues.ticketId, ticketId))
      ).length;
      const outcome = await linkIssue(me, ticketId, {
        repository: "someone/else-entirely",
        number: 1,
      }).then(
        () => "linked",
        (error: unknown) => (error instanceof Error ? error.message : "refused"),
      );
      const after = (
        await db().select().from(ticketIssues).where(eq(ticketIssues.ticketId, ticketId))
      ).length;
      return {
        got: `${outcome}, links before ${String(before)} and after ${String(after)}`,
        pass: outcome !== "linked" && before === after,
      };
    },
  );
  await record(
    "issues",
    "unlinking removes the link and writes nothing to GitHub",
    "no link left",
    async () => {
      const [row] = await db()
        .select()
        .from(ticketIssues)
        .where(eq(ticketIssues.ticketId, ticketId));
      if (row) await unlinkIssue(me, ticketId, row.id);
      const left = await db()
        .select()
        .from(ticketIssues)
        .where(eq(ticketIssues.ticketId, ticketId));
      return { got: `${String(left.length)} link(s) left`, pass: left.length === 0 };
    },
  );
  const passed = rows.filter((row) => row.pass).length;
  const lines = [
    `# Sources of knowledge and issues against the real GitHub and a real documentation site`,
    "",
    `Run on ${new Date().toISOString().slice(0, 10)}: ${String(passed)} of ${String(rows.length)} checks passed. The repository and the page are named in the command, the token is not part of this file. Nothing was published or changed at GitHub.`,
    "",
    "| Group | Check | Expected | Result | Result of the check | Time |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.group} | ${row.name} | ${row.expected} | ${row.got.replaceAll("|", "\\|")} | ${row.pass ? "passed" : "FAILED"} | ${String(row.took)} ms |`,
    ),
    "",
  ].join("\n");
  if (process.argv[2]) writeFileSync(process.argv[2], lines);
  console.log(`\n${String(passed)} of ${String(rows.length)} passed`);
}
try {
  await main();
} finally {
  await wipe();
  await sqlClient().end();
}
