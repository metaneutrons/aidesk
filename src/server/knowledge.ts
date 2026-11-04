import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  contextConfig,
  contextSecret,
  docsConfig,
  docsSecret,
  githubConfig,
  githubSecret,
} from "../domain/connections";
import { permits, type Principal } from "../domain/permissions";
import { cleanText } from "../domain/untrusted";
import { db } from "./db";
import { audit, connections, participants, tickets } from "./db/schema";
import { DomainError } from "./errors";
import { checkHost } from "./host-guard";
import { htmlToMarkdown } from "./inbound";
import { unsealSecret } from "./secrets";
// Retrieval from the sources of knowledge of a project: the issues of its repositories, the pages of
// its documentation, and what its customer system knows about the requester of a ticket. It reads
// only, for the project that owns the connection, and answers with text, where it came from and
// when it was fetched. A source that cannot be read is named as unavailable and nothing is made up
// in its place. What comes back is written by others and is data, never an instruction.
export const knowledgeQuery = z.string().trim().min(2).max(200);
export interface Passage {
  connectionId: string;
  kind: "github" | "docs" | "context";
  source: string;
  reference: string;
  title: string;
  text: string;
  fetchedAt: string;
}
export interface SourceState {
  connectionId: string;
  kind: string;
  name: string;
  state: "ok" | "unavailable" | "not_verified";
  error: string | null;
  fetchedAt: string;
  found: number;
}
export interface KnowledgeDeps {
  fetch?: typeof fetch;
  now?: () => Date;
}
const waitMs = 8000;
const bodyLimit = 500_000;
const perSource = 6;
const total = 12;
const excerpt = 800;
const cacheMs = 120_000;
const pages = new Map<string, { at: number; text: string }>();
export const clearKnowledgeCache = (): void => {
  pages.clear();
};
// The words of a query that a search may use: letters and digits, so that a query cannot carry a
// qualifier (`repo:`, `org:`) that would widen a search beyond the repositories of the connection.
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return [...new Set(words)].slice(0, 8);
}
const clean = (value: unknown, limit: number): string =>
  typeof value === "string" ? cleanText(value).text.trim().slice(0, limit) : "";
const failure = (code: string) => Object.assign(new Error(code), { knowledge: code });
async function get(
  deps: KnowledgeDeps,
  url: string,
  headers: Record<string, string>,
  development: boolean,
): Promise<{ type: string; text: string }> {
  const target = new URL(url);
  if (!development && (await checkHost(target.hostname)) !== "allowed")
    throw failure("host_refused");
  const response = await (deps.fetch ?? fetch)(url, {
    headers,
    // A redirect would take a key to another host.
    redirect: "manual",
    signal: AbortSignal.timeout(waitMs),
  });
  if (!response.ok) throw failure(`http_${String(response.status)}`);
  return {
    type: response.headers.get("content-type") ?? "",
    text: (await response.text()).slice(0, bodyLimit),
  };
}
function codeOf(error: unknown): string {
  const known = (error as { knowledge?: unknown }).knowledge;
  if (typeof known === "string") return known;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (error instanceof SyntaxError) return "bad_response";
  return "unreachable";
}
const issueResult = z.object({
  items: z.array(
    z
      .object({
        number: z.number().int(),
        title: z.string(),
        state: z.string(),
        html_url: z.string(),
        body: z.string().nullish(),
        repository_url: z.string(),
        pull_request: z.unknown().optional(),
      })
      .loose(),
  ),
});
async function fromGithub(
  row: typeof connections.$inferSelect,
  terms: string[],
  deps: KnowledgeDeps,
  at: string,
): Promise<Passage[]> {
  const config = githubConfig.parse(row.config);
  const secret = githubSecret.parse(JSON.parse(unsealSecret(row.secretCiphertext ?? "")));
  const base = (config.endpoint ?? "https://api.github.com").replace(/\/+$/, "");
  const found: Passage[] = [];
  for (const repository of config.repositories) {
    const search = `${terms.join(" ")} repo:${repository}`;
    const { text } = await get(
      deps,
      `${base}/search/issues?q=${encodeURIComponent(search)}&per_page=5&sort=updated`,
      {
        Authorization: `Bearer ${secret.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "aidesk",
      },
      config.developmentOnly,
    );
    const parsed = issueResult.safeParse(JSON.parse(text));
    if (!parsed.success) throw failure("bad_response");
    for (const item of parsed.data.items) {
      // A result of another repository is not one of this connection, whatever the search said.
      if (!item.repository_url.toLowerCase().endsWith(`/repos/${repository.toLowerCase()}`))
        continue;
      if (!/^https?:\/\//.test(item.html_url)) continue;
      found.push({
        connectionId: row.id,
        kind: "github",
        source: row.name,
        reference: item.html_url,
        title: clean(
          `${item.pull_request ? "Pull request" : "Issue"} ${repository}#${String(item.number)} ${item.title} (${item.state})`,
          200,
        ),
        text: clean(item.body, excerpt),
        fetchedAt: at,
      });
    }
  }
  return found;
}
async function fromDocs(
  row: typeof connections.$inferSelect,
  terms: string[],
  deps: KnowledgeDeps,
  at: string,
  now: number,
): Promise<Passage[]> {
  const config = docsConfig.parse(row.config);
  const secret = row.secretCiphertext
    ? docsSecret.parse(JSON.parse(unsealSecret(row.secretCiphertext)))
    : null;
  const found: { score: number; passage: Passage }[] = [];
  for (const page of config.pages) {
    const key = `${row.id}:${String(row.version)}:${page.url}`;
    let text = pages.get(key)?.text;
    const cached = pages.get(key);
    if (!cached || now - cached.at > cacheMs) {
      const got = await get(
        deps,
        page.url,
        secret ? { Authorization: `Bearer ${secret.token}` } : {},
        config.developmentOnly,
      );
      text = /html/i.test(got.type) ? htmlToMarkdown(got.text) : got.text;
      pages.set(key, { at: now, text });
    }
    const paragraphs = (text ?? "").split(/\n\s*\n/).map((paragraph) => paragraph.trim());
    const scored = paragraphs
      .filter((paragraph) => paragraph.length >= 20)
      .map((paragraph) => ({
        paragraph,
        score: terms.filter((term) => paragraph.toLowerCase().includes(term)).length,
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    for (const entry of scored)
      found.push({
        score: entry.score,
        passage: {
          connectionId: row.id,
          kind: "docs",
          source: row.name,
          reference: page.url,
          title: clean(page.title, 200),
          text: clean(entry.paragraph, excerpt),
          fetchedAt: at,
        },
      });
  }
  return found.sort((a, b) => b.score - a.score).map((entry) => entry.passage);
}
function lines(value: unknown, prefix = "", depth = 0): string[] {
  if (Array.isArray(value))
    return value.flatMap((item) => lines(item, prefix, depth + 1)).slice(0, 20);
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, item]) =>
      depth > 2 ? [] : lines(item, prefix ? `${prefix}.${key}` : key, depth + 1),
    );
  return value === null || value === undefined
    ? []
    : [`${prefix}: ${clean(typeof value === "string" ? value : JSON.stringify(value), 200)}`];
}
async function fromContext(
  row: typeof connections.$inferSelect,
  requester: string,
  deps: KnowledgeDeps,
  at: string,
): Promise<Passage[]> {
  const config = contextConfig.parse(row.config);
  const secret = contextSecret.parse(JSON.parse(unsealSecret(row.secretCiphertext ?? "")));
  const joiner = config.endpoint.includes("?") ? "&" : "?";
  const { text } = await get(
    deps,
    `${config.endpoint}${joiner}email=${encodeURIComponent(requester)}`,
    { Authorization: `Bearer ${secret.apiKey}`, Accept: "application/json" },
    config.developmentOnly,
  );
  const body: unknown = JSON.parse(text);
  if (typeof body !== "object" || body === null) throw failure("bad_response");
  const rendered = lines(body).slice(0, 40).join("\n");
  if (!rendered) return [];
  return [
    {
      connectionId: row.id,
      kind: "context",
      source: row.name,
      reference: new URL(config.endpoint).hostname,
      title: "Customer data",
      text: clean(rendered, 3000),
      fetchedAt: at,
    },
  ];
}
// The passages of the sources of the ticket's project that match a query, and the state of each
// source. The requester of the ticket is the only customer whose data is asked for, and only when
// the product has a verified record of that address for the ticket.
export async function searchKnowledge(
  principal: Principal,
  ticketId: string,
  query: unknown,
  deps: KnowledgeDeps = {},
) {
  const text = knowledgeQuery.parse(query);
  const [ticket] = await db()
    .select()
    .from(tickets)
    .where(eq(tickets.id, z.uuid().parse(ticketId)));
  if (!ticket || !permits(principal, ticket.projectId, "ticket.read"))
    throw new DomainError("not_found", 404);
  const terms = searchTerms(text);
  if (terms.length === 0)
    throw new z.ZodError([{ code: "custom", path: ["query"], message: "Use letters or digits" }]);
  const rows = await db()
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.projectId, ticket.projectId),
        eq(connections.direction, "knowledge"),
        inArray(connections.status, ["ready", "degraded"]),
      ),
    )
    .orderBy(connections.name);
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  const [verified] = await db()
    .select({ id: participants.id })
    .from(participants)
    .where(
      and(
        eq(participants.ticketId, ticket.id),
        eq(participants.email, ticket.requesterEmail.toLowerCase()),
        eq(participants.verified, true),
        isNull(participants.revokedAt),
      ),
    );
  const outcomes = await Promise.all(
    rows.map(async (row): Promise<{ state: SourceState; passages: Passage[] }> => {
      const base = { connectionId: row.id, kind: row.kind, name: row.name, fetchedAt: at };
      try {
        if (row.kind === "context" && !verified)
          return {
            state: { ...base, state: "not_verified", error: null, found: 0 },
            passages: [],
          };
        const passages =
          row.kind === "github"
            ? await fromGithub(row, terms, deps, at)
            : row.kind === "docs"
              ? await fromDocs(row, terms, deps, at, now.getTime())
              : row.kind === "context"
                ? await fromContext(row, ticket.requesterEmail.toLowerCase(), deps, at)
                : [];
        const kept = passages.slice(0, perSource);
        return { state: { ...base, state: "ok", error: null, found: kept.length }, passages: kept };
      } catch (error) {
        return {
          state: { ...base, state: "unavailable", error: codeOf(error), found: 0 },
          passages: [],
        };
      }
    }),
  );
  await db()
    .insert(audit)
    .values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "knowledge.search",
      targetId: ticket.id,
      detail: {
        actorKind: principal.kind,
        queryLength: text.length,
        sources: outcomes.length,
        unavailable: outcomes.filter((entry) => entry.state.state === "unavailable").length,
        passages: outcomes.reduce((sum, entry) => sum + entry.passages.length, 0),
      },
    });
  return {
    untrusted: true as const,
    passages: outcomes.flatMap((entry) => entry.passages).slice(0, total),
    sources: outcomes.map((entry) => entry.state),
  };
}
