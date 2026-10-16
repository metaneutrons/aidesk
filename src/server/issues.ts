import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { githubConfig, repositoryName } from "../domain/connections";
import { permits, type Action, type Principal } from "../domain/permissions";
import { cleanText } from "../domain/untrusted";
import { db } from "./db";
import { audit, connections, issueDrafts, ticketIssues, tickets } from "./db/schema";
import { DomainError } from "./errors";
import { githubRequest, type GithubConnection, type GithubDeps, type GithubResult } from "./github";
import { searchTerms } from "./knowledge";
// Issues of the repositories of a project, from a ticket: search, link, and publish a draft that a
// person wrote. Nothing is taken from the ticket, so no private note and no customer data gets into
// an issue by itself, and nothing about an issue is shown to the customer. A link only reads, and
// closing an issue changes nothing about the ticket. Publishing needs the right `github.publish`
// and a person: a draft is published once, and a publication whose outcome is unknown waits to be
// looked up in the repository before it can be repeated.
const marker = (draftId: string) => `<!-- aidesk-draft:${draftId} -->`;
const staleAfterMs = 2 * 60_000;
export const linkInput = z
  .object({ repository: repositoryName, number: z.number().int().min(1) })
  .strict();
export const draftInput = z
  .object({
    repository: repositoryName,
    title: z.string().trim().min(1).max(256),
    body: z.string().max(20_000),
  })
  .strict();
export const draftUpdate = z
  .object({
    title: z.string().trim().min(1).max(256),
    body: z.string().max(20_000),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export const publishInput = z.object({ expectedVersion: z.number().int().min(1) }).strict();
const id = z.uuid();
async function ticketFor(principal: Principal, ticketId: string, action: Action) {
  const [ticket] = await db()
    .select()
    .from(tickets)
    .where(eq(tickets.id, id.parse(ticketId)));
  if (!ticket || !permits(principal, ticket.projectId, "ticket.read"))
    throw new DomainError("not_found", 404);
  if (!permits(principal, ticket.projectId, action)) throw new DomainError("forbidden", 403);
  return ticket;
}
// The connections of a project that name repositories, and the repositories with their connection.
async function sources(projectId: string, writable: boolean) {
  const rows = await db()
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.projectId, projectId),
        eq(connections.kind, "github"),
        eq(connections.direction, "knowledge"),
        inArray(connections.status, writable ? ["ready"] : ["ready", "degraded"]),
      ),
    )
    .orderBy(asc(connections.name));
  return rows.flatMap((row) =>
    githubConfig
      .parse(row.config)
      .repositories.map((repository) => ({ connection: row, repository })),
  );
}
async function connectionOf(projectId: string, repository: string, writable: boolean) {
  const found = (await sources(projectId, writable)).find(
    (entry) => entry.repository.toLowerCase() === repository.toLowerCase(),
  );
  // A repository of no connection of this project is not one that this project may touch.
  if (!found) throw new DomainError("not_found", 404);
  return found;
}
const issueBody = z
  .object({
    number: z.number().int(),
    title: z.string(),
    state: z.string(),
    html_url: z.string(),
    body: z.string().nullish(),
    pull_request: z.unknown().optional(),
  })
  .loose();
const safeUrl = (url: string): boolean => /^https?:\/\//.test(url);
// A source that did not answer as needed. The reason is not given to the caller; the audit and the
// state of the connection hold what there is to know.
const failed = (_result: Extract<GithubResult, { kind: "unknown" }> | { status: number }) =>
  new DomainError("source_unavailable", 502);
// What a person sees of the issues of a ticket and what the project can do with them: the
// repositories (none: no controls), the links with their last known state, and the drafts.
export async function listIssues(principal: Principal, ticketId: string) {
  const ticket = await ticketFor(principal, ticketId, "ticket.read");
  const links = await db()
    .select()
    .from(ticketIssues)
    .where(eq(ticketIssues.ticketId, ticket.id))
    .orderBy(asc(ticketIssues.linkedAt));
  const drafts = await db()
    .select()
    .from(issueDrafts)
    .where(and(eq(issueDrafts.ticketId, ticket.id), notInArray(issueDrafts.state, ["discarded"])))
    .orderBy(desc(issueDrafts.createdAt));
  return {
    repositories: (await sources(ticket.projectId, false)).map((entry) => ({
      connectionId: entry.connection.id,
      repository: entry.repository,
    })),
    links: links.map((link) => ({
      id: link.id,
      repository: link.repository,
      number: link.number,
      url: link.url,
      title: link.title,
      state: link.state,
      origin: link.origin,
      refreshedAt: link.refreshedAt,
      refreshError: link.refreshError,
    })),
    drafts: drafts.map((draft) => ({
      id: draft.id,
      repository: draft.repository,
      title: draft.title,
      body: draft.body,
      state: draft.state,
      version: draft.version,
      errorCode: draft.errorCode,
      publishedNumber: draft.publishedNumber,
      publishedUrl: draft.publishedUrl,
    })),
  };
}
const searchResult = z.object({ items: z.array(issueBody.extend({ repository_url: z.string() })) });
// Issues of the repositories of the project that match words, read at once. The words are reduced
// to letters and digits, so that a query cannot widen the search beyond the repositories.
export async function searchIssues(
  principal: Principal,
  ticketId: string,
  query: unknown,
  deps: GithubDeps = {},
) {
  const text = z.string().trim().min(2).max(200).parse(query);
  const ticket = await ticketFor(principal, ticketId, "ticket.read");
  const terms = searchTerms(text);
  if (terms.length === 0)
    throw new z.ZodError([{ code: "custom", path: ["q"], message: "Use letters or digits" }]);
  const found: {
    repository: string;
    number: number;
    title: string;
    state: string;
    url: string;
    pullRequest: boolean;
  }[] = [];
  const problems: { repository: string; error: string }[] = [];
  for (const entry of await sources(ticket.projectId, false)) {
    const result = await githubRequest(
      entry.connection,
      {
        method: "GET",
        path: `/search/issues?q=${encodeURIComponent(`${terms.join(" ")} repo:${entry.repository}`)}&per_page=10&sort=updated`,
      },
      deps,
    );
    const parsed =
      result.kind === "answer" && result.status === 200
        ? searchResult.safeParse(result.json)
        : null;
    if (!parsed?.success) {
      problems.push({
        repository: entry.repository,
        error: result.kind === "answer" ? `http_${String(result.status)}` : result.code,
      });
      continue;
    }
    for (const item of parsed.data.items) {
      if (
        !item.repository_url.toLowerCase().endsWith(`/repos/${entry.repository.toLowerCase()}`) ||
        !safeUrl(item.html_url)
      )
        continue;
      found.push({
        repository: entry.repository,
        number: item.number,
        title: cleanText(item.title).text.slice(0, 200),
        state: item.state,
        url: item.html_url,
        pullRequest: item.pull_request !== undefined,
      });
    }
  }
  return { issues: found, problems };
}
async function readIssue(
  connection: GithubConnection,
  repository: string,
  number: number,
  deps: GithubDeps,
) {
  const result = await githubRequest(
    connection,
    { method: "GET", path: `/repos/${repository}/issues/${String(number)}` },
    deps,
  );
  if (result.kind === "answer" && result.status === 404) throw new DomainError("not_found", 404);
  const parsed =
    result.kind === "answer" && result.status === 200 ? issueBody.safeParse(result.json) : null;
  if (!parsed?.success || !safeUrl(parsed.data.html_url))
    throw failed(result.kind === "answer" ? { status: result.status } : result);
  return {
    title: cleanText(parsed.data.title).text.slice(0, 256),
    state: parsed.data.state,
    url: parsed.data.html_url,
  };
}
// A link between a ticket and an issue of one of the project's repositories. Linking twice is one
// link; the issue is read once to check that it exists and to show its title and state.
export async function linkIssue(
  principal: Principal,
  ticketId: string,
  input: unknown,
  deps: GithubDeps = {},
) {
  const request = linkInput.parse(input);
  const ticket = await ticketFor(principal, ticketId, "ticket.note");
  const { connection, repository } = await connectionOf(
    ticket.projectId,
    request.repository,
    false,
  );
  const issue = await readIssue(connection, repository, request.number, deps);
  const [link] = await db()
    .insert(ticketIssues)
    .values({
      ticketId: ticket.id,
      projectId: ticket.projectId,
      connectionId: connection.id,
      repository,
      number: request.number,
      url: issue.url,
      title: issue.title,
      state: issue.state,
      origin: "linked",
      linkedBy: principal.id,
      refreshedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (link)
    await db()
      .insert(audit)
      .values({
        projectId: ticket.projectId,
        actorId: principal.id,
        action: "issue.link",
        targetId: ticket.id,
        detail: { repository, number: request.number, actorKind: principal.kind },
      });
  const [stored] = await db()
    .select()
    .from(ticketIssues)
    .where(
      and(
        eq(ticketIssues.ticketId, ticket.id),
        eq(ticketIssues.repository, repository),
        eq(ticketIssues.number, request.number),
      ),
    );
  return { id: stored?.id ?? "", repository, number: request.number, created: link !== undefined };
}
export async function unlinkIssue(principal: Principal, ticketId: string, linkId: string) {
  const ticket = await ticketFor(principal, ticketId, "ticket.note");
  const removed = await db()
    .delete(ticketIssues)
    .where(and(eq(ticketIssues.id, id.parse(linkId)), eq(ticketIssues.ticketId, ticket.id)))
    .returning();
  if (removed.length === 0) throw new DomainError("not_found", 404);
  await db()
    .insert(audit)
    .values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "issue.unlink",
      targetId: ticket.id,
      detail: { repository: removed[0]?.repository, number: removed[0]?.number },
    });
  return { removed: true as const };
}
async function refreshLink(link: typeof ticketIssues.$inferSelect, deps: GithubDeps) {
  const [connection] = await db()
    .select()
    .from(connections)
    .where(eq(connections.id, link.connectionId));
  if (!connection || connection.status === "disabled" || connection.status === "draft") {
    await db()
      .update(ticketIssues)
      .set({ refreshError: "source_not_ready" })
      .where(eq(ticketIssues.id, link.id));
    return;
  }
  const result = await githubRequest(
    connection,
    { method: "GET", path: `/repos/${link.repository}/issues/${String(link.number)}` },
    deps,
  );
  const parsed =
    result.kind === "answer" && result.status === 200 ? issueBody.safeParse(result.json) : null;
  if (!parsed?.success) {
    // The last known state stays, and says why it was not refreshed.
    await db()
      .update(ticketIssues)
      .set({
        refreshError: result.kind === "answer" ? `http_${String(result.status)}` : result.code,
      })
      .where(eq(ticketIssues.id, link.id));
    return;
  }
  await db()
    .update(ticketIssues)
    .set({
      state: parsed.data.state,
      title: cleanText(parsed.data.title).text.slice(0, 256),
      refreshedAt: new Date(),
      refreshError: null,
    })
    .where(eq(ticketIssues.id, link.id));
}
// The state of the linked issues of a ticket, read again. A failure keeps the last known state.
export async function refreshIssues(principal: Principal, ticketId: string, deps: GithubDeps = {}) {
  const ticket = await ticketFor(principal, ticketId, "ticket.read");
  const links = await db().select().from(ticketIssues).where(eq(ticketIssues.ticketId, ticket.id));
  for (const link of links) await refreshLink(link, deps);
  return listIssues(principal, ticketId);
}
// Reconciliation in the background: the issues linked to tickets that are not resolved or in junk,
// a few at a time, oldest reading first.
export async function reconcileIssues(
  now: Date = new Date(),
  deps: GithubDeps = {},
  limit = 25,
  olderThanMs = 15 * 60_000,
): Promise<number> {
  const due = await db()
    .select({ link: ticketIssues })
    .from(ticketIssues)
    .innerJoin(tickets, eq(tickets.id, ticketIssues.ticketId))
    .where(
      and(
        isNull(tickets.junkAt),
        sql`${tickets.status} <> 'resolved'`,
        or(
          isNull(ticketIssues.refreshedAt),
          lt(ticketIssues.refreshedAt, new Date(now.getTime() - olderThanMs)),
        ),
      ),
    )
    .orderBy(sql`${ticketIssues.refreshedAt} asc nulls first`)
    .limit(limit);
  for (const { link } of due) await refreshLink(link, deps);
  return due.length;
}
export async function createIssueDraft(principal: Principal, ticketId: string, input: unknown) {
  const request = draftInput.parse(input);
  const ticket = await ticketFor(principal, ticketId, "ticket.note");
  const { connection, repository } = await connectionOf(
    ticket.projectId,
    request.repository,
    false,
  );
  const [draft] = await db()
    .insert(issueDrafts)
    .values({
      ticketId: ticket.id,
      projectId: ticket.projectId,
      connectionId: connection.id,
      repository,
      title: request.title,
      body: request.body,
      createdBy: principal.id,
    })
    .returning({ id: issueDrafts.id, version: issueDrafts.version });
  await db()
    .insert(audit)
    .values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "issue.draft_create",
      targetId: draft?.id ?? null,
      detail: { repository, actorKind: principal.kind },
    });
  return { id: draft?.id ?? "", version: draft?.version ?? 1 };
}
async function draftFor(principal: Principal, draftId: string, action: Action) {
  const [draft] = await db()
    .select()
    .from(issueDrafts)
    .where(eq(issueDrafts.id, id.parse(draftId)));
  if (!draft) throw new DomainError("not_found", 404);
  const ticket = await ticketFor(principal, draft.ticketId, action);
  return { draft, ticket };
}
export async function updateIssueDraft(principal: Principal, draftId: string, input: unknown) {
  const request = draftUpdate.parse(input);
  const { draft } = await draftFor(principal, draftId, "ticket.note");
  if (draft.version !== request.expectedVersion) throw new DomainError("stale_version", 409);
  const [changed] = await db()
    .update(issueDrafts)
    .set({
      title: request.title,
      body: request.body,
      version: draft.version + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issueDrafts.id, draft.id),
        eq(issueDrafts.version, draft.version),
        inArray(issueDrafts.state, ["draft", "failed"]),
      ),
    )
    .returning({ version: issueDrafts.version });
  if (!changed) throw new DomainError("conflict", 409);
  return { id: draft.id, version: changed.version };
}
export async function discardIssueDraft(principal: Principal, draftId: string) {
  const { draft, ticket } = await draftFor(principal, draftId, "ticket.note");
  const [changed] = await db()
    .update(issueDrafts)
    .set({ state: "discarded", version: draft.version + 1, updatedAt: new Date() })
    .where(and(eq(issueDrafts.id, draft.id), inArray(issueDrafts.state, ["draft", "failed"])))
    .returning({ id: issueDrafts.id });
  if (!changed) throw new DomainError("conflict", 409);
  await db().insert(audit).values({
    projectId: ticket.projectId,
    actorId: principal.id,
    action: "issue.draft_discard",
    targetId: draft.id,
  });
  return { discarded: true as const };
}
async function conclude(
  draftId: string,
  ticket: typeof tickets.$inferSelect,
  principal: Principal,
  repository: string,
  connectionId: string,
  issue: { number: number; title: string; state: string; url: string },
) {
  await db().transaction(async (tx) => {
    await tx
      .update(issueDrafts)
      .set({
        state: "published",
        errorCode: null,
        publishedNumber: issue.number,
        publishedUrl: issue.url,
        updatedAt: new Date(),
      })
      .where(eq(issueDrafts.id, draftId));
    await tx
      .insert(ticketIssues)
      .values({
        ticketId: ticket.id,
        projectId: ticket.projectId,
        connectionId,
        repository,
        number: issue.number,
        url: issue.url,
        title: issue.title,
        state: issue.state,
        origin: "created",
        linkedBy: principal.id,
        refreshedAt: new Date(),
      })
      .onConflictDoNothing();
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "issue.publish",
      targetId: draftId,
      detail: { repository, number: issue.number },
    });
  });
}
const humans = (principal: Principal) => {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
};
// Publishes a draft as an issue of its repository, once. The draft goes out as the person
// reviewed it, with a marker in a comment that lets a publication of unknown outcome be found.
export async function publishIssue(
  principal: Principal,
  draftId: string,
  input: unknown,
  deps: GithubDeps = {},
) {
  const request = publishInput.parse(input);
  humans(principal);
  const { draft, ticket } = await draftFor(principal, draftId, "github.publish");
  const shown = (row: typeof draft) => ({
    id: row.id,
    state: row.state,
    version: row.version,
    number: row.publishedNumber,
    url: row.publishedUrl,
    errorCode: row.errorCode,
  });
  // What was published or is being published stays as it is: asking again is the same answer.
  if (draft.state === "published" || draft.state === "publishing") return shown(draft);
  if (draft.state === "uncertain" || draft.state === "discarded")
    throw new DomainError("conflict", 409);
  if (draft.version !== request.expectedVersion) throw new DomainError("stale_version", 409);
  const { connection } = await connectionOf(ticket.projectId, draft.repository, true);
  const [taken] = await db()
    .update(issueDrafts)
    .set({
      state: "publishing",
      version: draft.version + 1,
      errorCode: null,
      publishedBy: principal.id,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(issueDrafts.id, draft.id),
        eq(issueDrafts.version, draft.version),
        inArray(issueDrafts.state, ["draft", "failed"]),
      ),
    )
    .returning();
  // Another request took it first: it is theirs, and this one gets the answer they get.
  if (!taken) {
    const [now] = await db().select().from(issueDrafts).where(eq(issueDrafts.id, draft.id));
    if (!now || now.state === "draft" || now.state === "failed")
      throw new DomainError("conflict", 409);
    return shown(now);
  }
  const result = await githubRequest(
    connection,
    {
      method: "POST",
      path: `/repos/${draft.repository}/issues`,
      body: { title: draft.title, body: `${draft.body}\n\n${marker(draft.id)}` },
    },
    deps,
  );
  const created =
    result.kind === "answer" && result.status === 201 ? issueBody.safeParse(result.json) : null;
  if (created?.success && safeUrl(created.data.html_url)) {
    await conclude(draft.id, ticket, principal, draft.repository, connection.id, {
      number: created.data.number,
      title: draft.title,
      state: created.data.state,
      url: created.data.html_url,
    });
  } else {
    // GitHub refused: it did nothing, and the draft stays for another try. Anything else may have
    // created the issue, so it is looked up before it is tried again.
    const refused = result.kind === "answer" && result.status >= 400 && result.status < 500;
    await db()
      .update(issueDrafts)
      .set({
        state: refused ? "failed" : "uncertain",
        errorCode: refused
          ? `http_${String((result as { status: number }).status)}`
          : "unknown_outcome",
        updatedAt: new Date(),
      })
      .where(eq(issueDrafts.id, draft.id));
    await db()
      .insert(audit)
      .values({
        projectId: ticket.projectId,
        actorId: principal.id,
        action: refused ? "issue.publish_refused" : "issue.publish_uncertain",
        targetId: draft.id,
      });
  }
  const [after] = await db().select().from(issueDrafts).where(eq(issueDrafts.id, draft.id));
  return shown(after ?? draft);
}
// Looks for the issue that a publication of unknown outcome may have created, by its marker among
// the newest issues of the repository. Found: the draft is published and the issue linked. Not
// found: nothing was created and the draft can be published again.
export async function reconcileIssueDraft(
  principal: Principal,
  draftId: string,
  deps: GithubDeps = {},
) {
  humans(principal);
  const { draft, ticket } = await draftFor(principal, draftId, "github.publish");
  const stuck =
    draft.state === "publishing" && Date.now() - draft.updatedAt.getTime() > staleAfterMs;
  if (draft.state !== "uncertain" && !stuck) throw new DomainError("conflict", 409);
  const { connection } = await connectionOf(ticket.projectId, draft.repository, false);
  const since = new Date(draft.createdAt.getTime() - 60_000).toISOString();
  const result = await githubRequest(
    connection,
    {
      method: "GET",
      path: `/repos/${draft.repository}/issues?state=all&sort=created&direction=desc&per_page=50&since=${encodeURIComponent(since)}`,
    },
    deps,
  );
  const parsed =
    result.kind === "answer" && result.status === 200
      ? z.array(issueBody).safeParse(result.json)
      : null;
  if (!parsed?.success) throw failed(result.kind === "answer" ? { status: result.status } : result);
  const match = parsed.data.find(
    (item) =>
      item.pull_request === undefined &&
      (item.body ?? "").includes(marker(draft.id)) &&
      safeUrl(item.html_url),
  );
  if (match) {
    await conclude(draft.id, ticket, principal, draft.repository, connection.id, {
      number: match.number,
      title: draft.title,
      state: match.state,
      url: match.html_url,
    });
    return { id: draft.id, state: "published" as const, number: match.number, url: match.html_url };
  }
  await db()
    .update(issueDrafts)
    .set({ state: "failed", errorCode: "not_found_after_check", updatedAt: new Date() })
    .where(eq(issueDrafts.id, draft.id));
  return { id: draft.id, state: "failed" as const, number: null, url: null };
}
