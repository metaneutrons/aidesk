import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  connections,
  issueDrafts,
  messages,
  projects,
  ticketIssues,
  tickets,
} from "../src/server/db/schema";
import {
  createIssueDraft,
  discardIssueDraft,
  linkIssue,
  listIssues,
  publishIssue,
  reconcileIssueDraft,
  reconcileIssues,
  refreshIssues,
  searchIssues,
  unlinkIssue,
  updateIssueDraft,
} from "../src/server/issues";
import { getPortalTicket, issuePortalGrant } from "../src/server/portal";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
import type { Action, Principal } from "../src/domain/permissions";
// Issues of the repositories of a project, from a ticket, against a server that answers like GitHub
// and keeps the issues that are created in it.
const projectId = randomUUID();
const otherProject = randomUUID();
const person = (held: Action[], id: string, project = projectId): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId: project, actions: held }],
});
const base: Action[] = ["project.read", "ticket.read"];
const editor = person([...base, "ticket.note"], `editor-${projectId}`);
const publisher = person([...base, "ticket.note", "github.publish"], `publisher-${projectId}`);
const publishOnly = person([...base, "github.publish"], `po-${projectId}`);
const reader = person(base, `reader-${projectId}`);
const stranger = person([...base, "ticket.note", "github.publish"], `x-${projectId}`, otherProject);
interface Stored {
  number: number;
  title: string;
  body: string;
  state: string;
  repository: string;
  pull?: boolean;
}
const store: Stored[] = [];
const requests: { method: string; url: string; body: string; authorization: string }[] = [];
let behaviour: {
  // The create call: answer with this status without or with creating the issue.
  create?: { status: number; created: boolean };
  search?: { status: number; body?: unknown };
  read?: { status: number };
} = {};
let server: Server;
let origin = "";
let connectionId = "";
const issueJson = (item: Stored) => ({
  number: item.number,
  title: item.title,
  state: item.state,
  html_url: `https://github.example/${item.repository}/issues/${String(item.number)}`,
  body: item.body,
  ...(item.pull ? { pull_request: {} } : {}),
  repository_url: `https://api.github.example/repos/${item.repository}`,
});
async function ticket(project = projectId, values: Partial<typeof tickets.$inferInsert> = {}) {
  const [created] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject: "SECRET-SUBJECT printer",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      pendingSince: new Date(Date.now() - 3_600_000),
      ...values,
    })
    .returning({ id: tickets.id });
  await db()
    .insert(messages)
    .values([
      {
        ticketId: created?.id ?? "",
        authorType: "customer",
        authorName: "Kim",
        markdown: "SECRET-CUSTOMER-TEXT",
        language: "en",
        deliveryState: "received",
      },
      {
        ticketId: created?.id ?? "",
        authorType: "human",
        authorName: "Lena",
        markdown: "SECRET-PRIVATE-NOTE",
        internal: true,
        language: "en",
        deliveryState: "internal",
      },
    ]);
  return created?.id ?? "";
}
const reset = async () => {
  const ids = [projectId, otherProject];
  await db().delete(issueDrafts).where(inArray(issueDrafts.projectId, ids));
  await db().delete(ticketIssues).where(inArray(ticketIssues.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  store.length = 0;
  requests.length = 0;
  behaviour = {};
};
const posts = () => requests.filter((request) => request.method === "POST");
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(request.url ?? "/", "http://localhost");
      requests.push({
        method: request.method ?? "",
        url: `${url.pathname}${url.search}`,
        body,
        authorization: request.headers.authorization ?? "",
      });
      const send = (status: number, json: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(json));
      };
      const create = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname);
      const one = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url.pathname);
      if (request.method === "POST" && create) {
        const plan = behaviour.create ?? { status: 201, created: true };
        const input = JSON.parse(body) as { title: string; body: string };
        let made: Stored | undefined;
        if (plan.created) {
          made = {
            number: 100 + store.length,
            title: input.title,
            body: input.body,
            state: "open",
            repository: create[1] ?? "",
          };
          store.push(made);
        }
        send(plan.status, made ? issueJson(made) : { message: "no" });
      } else if (request.method === "GET" && create) {
        send(
          200,
          store
            .filter((item) => item.repository === create[1])
            .map(issueJson)
            .reverse(),
        );
      } else if (request.method === "GET" && one) {
        if (behaviour.read) {
          send(behaviour.read.status, { message: "x" });
          return;
        }
        const found = store.find(
          (item) => item.repository === one[1] && String(item.number) === one[2],
        );
        if (found) send(200, issueJson(found));
        else send(404, { message: "Not Found" });
      } else if (url.pathname === "/search/issues") {
        if (behaviour.search) {
          send(behaviour.search.status, behaviour.search.body ?? {});
          return;
        }
        const repo = /repo:(\S+)/.exec(url.searchParams.get("q") ?? "")?.[1] ?? "";
        send(200, { items: store.filter((item) => item.repository === repo).map(issueJson) });
      } else send(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Issues", slug: `issues-${projectId}` },
      { id: otherProject, name: "Other", slug: `issues-o-${otherProject}` },
    ]);
  const [row] = await db()
    .insert(connections)
    .values({
      projectId,
      kind: "github",
      direction: "knowledge",
      name: "Repositories",
      status: "ready",
      config: { repositories: ["acme/app", "acme/docs"], endpoint: origin, developmentOnly: true },
      secretCiphertext: seal(JSON.stringify({ token: "ghp-issues" }), env().ENCRYPTION_KEY),
    })
    .returning({ id: connections.id });
  connectionId = row?.id ?? "";
}, 60_000);
beforeEach(reset);
afterAll(async () => {
  await reset();
  await db()
    .delete(audit)
    .where(inArray(audit.projectId, [projectId, otherProject]));
  await db().delete(connections).where(eq(connections.projectId, projectId));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProject]));
  await new Promise((resolve) => server.close(resolve));
  await sqlClient().end();
});
const seed = (repository: string, title: string, body = "", state = "open") => {
  store.push({ number: 7 + store.length, title, body, state, repository });
  return store.at(-1);
};
describe("what a ticket shows of issues", () => {
  it("is nothing for a project without a repository, and the repositories, links and drafts otherwise", async () => {
    const bare = await ticket(otherProject);
    expect((await listIssues(stranger, bare)).repositories).toEqual([]);
    const id = await ticket();
    const shown = await listIssues(reader, id);
    expect(shown.repositories).toEqual([
      { connectionId, repository: "acme/app" },
      { connectionId, repository: "acme/docs" },
    ]);
    expect(shown).toMatchObject({ links: [], drafts: [] });
    await expect(listIssues(stranger, id)).rejects.toMatchObject({ status: 404 });
    // A connection that is disabled is no source of repositories.
    await db()
      .update(connections)
      .set({ status: "disabled" })
      .where(eq(connections.id, connectionId));
    expect((await listIssues(reader, id)).repositories).toEqual([]);
    await db().update(connections).set({ status: "ready" }).where(eq(connections.id, connectionId));
  });
});
describe("a connection that is not ready", () => {
  it("still lets issues be read and linked, but not published", async () => {
    const found = seed("acme/app", "Grey pages");
    const id = await ticket();
    const made = await createIssueDraft(editor, id, {
      repository: "acme/app",
      title: "t",
      body: "",
    });
    await db()
      .update(connections)
      .set({ status: "degraded" })
      .where(eq(connections.id, connectionId));
    try {
      expect(
        (await linkIssue(editor, id, { repository: "acme/app", number: found?.number })).created,
      ).toBe(true);
      expect((await searchIssues(reader, id, "grey")).issues).toHaveLength(1);
      await expect(publishIssue(publisher, made.id, { expectedVersion: 1 })).rejects.toMatchObject({
        status: 404,
      });
      expect(posts()).toHaveLength(0);
      const [draft] = await db().select().from(issueDrafts).where(eq(issueDrafts.id, made.id));
      expect(draft?.state).toBe("draft");
    } finally {
      await db()
        .update(connections)
        .set({ status: "ready" })
        .where(eq(connections.id, connectionId));
    }
  });
});
describe("searching issues", () => {
  it("looks in each repository with words only, and names a repository that does not answer", async () => {
    seed("acme/app", "Grey pages");
    seed("acme/docs", "Grey docs");
    const id = await ticket();
    const result = await searchIssues(reader, id, "repo:evil/x grey pages");
    expect(result.issues.map((issue) => [issue.repository, issue.title])).toEqual([
      ["acme/app", "Grey pages"],
      ["acme/docs", "Grey docs"],
    ]);
    const q = decodeURIComponent(requests[0]?.url ?? "");
    expect(q.match(/repo:/g)).toHaveLength(1);
    expect(requests[0]?.authorization).toBe("Bearer ghp-issues");
    behaviour = { search: { status: 500 } };
    const down = await searchIssues(reader, id, "grey");
    expect(down).toEqual({
      issues: [],
      problems: [
        { repository: "acme/app", error: "http_500" },
        { repository: "acme/docs", error: "http_500" },
      ],
    });
    behaviour = {
      search: {
        status: 200,
        body: {
          items: [
            issueJson({
              number: 1,
              title: "Mine",
              body: "",
              state: "open",
              repository: "acme/app",
            }),
            issueJson({
              number: 2,
              title: "Theirs",
              body: "",
              state: "open",
              repository: "evil/secret",
            }),
            {
              ...issueJson({
                number: 3,
                title: "Odd",
                body: "",
                state: "open",
                repository: "acme/app",
              }),
              html_url: "javascript:alert(1)",
            },
          ],
        },
      },
    };
    const mixed = await searchIssues(reader, id, "grey");
    expect(mixed.issues.map((issue) => issue.title)).toEqual(["Mine"]);
    behaviour = { search: { status: 200, body: { items: "no" } } };
    expect((await searchIssues(reader, id, "grey")).problems).toHaveLength(2);
    await expect(searchIssues(reader, id, "?!")).rejects.toThrow();
    await expect(searchIssues(stranger, id, "grey")).rejects.toMatchObject({ status: 404 });
  });
});
describe("linking a ticket to an issue", () => {
  it("reads the issue once, links it once, and writes nothing to the repository", async () => {
    const found = seed("acme/app", "Grey pages", "Body", "open");
    const id = await ticket();
    const first = await linkIssue(editor, id, { repository: "acme/app", number: found?.number });
    expect(first).toMatchObject({ repository: "acme/app", number: found?.number, created: true });
    const again = await linkIssue(editor, id, { repository: "ACME/App", number: found?.number });
    expect(again).toMatchObject({ id: first.id, created: false });
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    const [link] = await listIssues(reader, id).then((view) => view.links);
    expect(link).toMatchObject({ title: "Grey pages", state: "open", origin: "linked" });
    const entries = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.targetId, id), eq(audit.action, "issue.link")));
    expect(entries).toHaveLength(1);
    // Nothing of the ticket went to the repository.
    expect(JSON.stringify(requests)).not.toContain("SECRET");
  });
  it("needs ticket.note, a repository of the project and an issue that exists", async () => {
    const found = seed("acme/app", "Grey pages");
    const id = await ticket();
    const input = { repository: "acme/app", number: found?.number };
    await expect(linkIssue(reader, id, input)).rejects.toMatchObject({ status: 403 });
    await expect(linkIssue(stranger, id, input)).rejects.toMatchObject({ status: 404 });
    await expect(
      linkIssue(editor, id, { repository: "evil/other", number: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      linkIssue(editor, id, { repository: "acme/app", number: 999 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(linkIssue(editor, id, { repository: "not a repo", number: 1 })).rejects.toThrow();
    behaviour = { read: { status: 500 } };
    await expect(linkIssue(editor, id, input)).rejects.toMatchObject({
      status: 502,
      code: "source_unavailable",
    });
    expect((await listIssues(reader, id)).links).toEqual([]);
    // An agent with the right may link; it only reads.
    const agent: Principal = { ...editor, id: randomUUID(), kind: "agent" };
    behaviour = {};
    expect((await linkIssue(agent, id, input)).created).toBe(true);
  });
  it("can be removed, by someone who may write notes, and only from its own ticket", async () => {
    const found = seed("acme/app", "Grey pages");
    const id = await ticket();
    const other = await ticket();
    const link = await linkIssue(editor, id, { repository: "acme/app", number: found?.number });
    await expect(unlinkIssue(reader, id, link.id)).rejects.toMatchObject({ status: 403 });
    await expect(unlinkIssue(editor, other, link.id)).rejects.toMatchObject({ status: 404 });
    expect(await unlinkIssue(editor, id, link.id)).toEqual({ removed: true });
    await expect(unlinkIssue(editor, id, link.id)).rejects.toMatchObject({ status: 404 });
  });
});
describe("a draft of an issue", () => {
  it("is what the person wrote, in a repository of the project, and nothing of the ticket", async () => {
    const id = await ticket();
    const made = await createIssueDraft(editor, id, {
      repository: "acme/app",
      title: " Fix grey pages ",
      body: "Steps",
    });
    const [row] = await db().select().from(issueDrafts).where(eq(issueDrafts.id, made.id));
    expect(row).toMatchObject({
      title: "Fix grey pages",
      body: "Steps",
      state: "draft",
      repository: "acme/app",
      createdBy: editor.id,
    });
    expect(JSON.stringify(row)).not.toContain("SECRET");
    await expect(
      createIssueDraft(reader, id, { repository: "acme/app", title: "t", body: "" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createIssueDraft(editor, id, { repository: "evil/x", title: "t", body: "" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createIssueDraft(editor, id, { repository: "acme/app", title: " ", body: "" }),
    ).rejects.toThrow();
    await expect(
      createIssueDraft(editor, id, {
        repository: "acme/app",
        title: "t",
        body: "x".repeat(20_001),
      }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it("is changed with the version that was read, and not once it is published or discarded", async () => {
    const id = await ticket();
    const made = await createIssueDraft(editor, id, {
      repository: "acme/app",
      title: "One",
      body: "a",
    });
    expect(
      await updateIssueDraft(editor, made.id, { title: "Two", body: "b", expectedVersion: 1 }),
    ).toEqual({ id: made.id, version: 2 });
    await expect(
      updateIssueDraft(editor, made.id, { title: "Three", body: "c", expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      updateIssueDraft(reader, made.id, { title: "x", body: "", expectedVersion: 2 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      updateIssueDraft(editor, randomUUID(), { title: "x", body: "", expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await discardIssueDraft(editor, made.id)).toEqual({ discarded: true });
    await expect(
      updateIssueDraft(editor, made.id, { title: "x", body: "", expectedVersion: 3 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(discardIssueDraft(editor, made.id)).rejects.toMatchObject({ status: 409 });
    expect((await listIssues(reader, id)).drafts).toEqual([]);
    const second = await createIssueDraft(editor, id, {
      repository: "acme/app",
      title: "Out",
      body: "",
    });
    await publishIssue(publisher, second.id, { expectedVersion: 1 });
    await expect(
      updateIssueDraft(editor, second.id, { title: "x", body: "", expectedVersion: 3 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(discardIssueDraft(editor, second.id)).rejects.toMatchObject({ status: 409 });
  });
});
describe("publishing a draft", () => {
  async function draft(title = "Fix grey pages", body = "Steps to reproduce") {
    const id = await ticket();
    const made = await createIssueDraft(editor, id, { repository: "acme/app", title, body });
    return { id, draft: made.id };
  }
  it("needs github.publish and a person, and goes out exactly as written, once", async () => {
    const { id, draft: draftId } = await draft();
    await expect(publishIssue(editor, draftId, { expectedVersion: 1 })).rejects.toMatchObject({
      status: 403,
    });
    await expect(publishIssue(reader, draftId, { expectedVersion: 1 })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      publishIssue({ ...publisher, kind: "agent" }, draftId, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(publishIssue(stranger, draftId, { expectedVersion: 1 })).rejects.toMatchObject({
      status: 404,
    });
    await expect(publishIssue(publisher, draftId, { expectedVersion: 5 })).rejects.toMatchObject({
      status: 409,
    });
    expect(posts()).toHaveLength(0);
    const done = await publishIssue(publisher, draftId, { expectedVersion: 1 });
    expect(done).toMatchObject({ state: "published", number: 100, errorCode: null });
    expect(done.url).toBe("https://github.example/acme/app/issues/100");
    expect(posts()).toHaveLength(1);
    const sent = JSON.parse(posts()[0]?.body ?? "{}") as { title: string; body: string };
    expect(sent.title).toBe("Fix grey pages");
    expect(sent.body).toBe(`Steps to reproduce\n\n<!-- aidesk-draft:${draftId} -->`);
    expect(posts()[0]?.authorization).toBe("Bearer ghp-issues");
    expect(JSON.stringify(requests)).not.toContain("SECRET");
    // The issue is linked to the ticket as created, and the ticket is as it was.
    const view = await listIssues(reader, id);
    expect(view.links).toEqual([
      expect.objectContaining({ number: 100, origin: "created", state: "open" }),
    ]);
    expect(view.drafts[0]).toMatchObject({ state: "published", publishedNumber: 100 });
    const [after] = await db().select().from(tickets).where(eq(tickets.id, id));
    expect(after).toMatchObject({ status: "open", revision: 1 });
    // Asking again, also with a stale version, gives the same issue and creates no second one.
    expect(await publishIssue(publisher, draftId, { expectedVersion: 1 })).toMatchObject({
      state: "published",
      number: 100,
    });
    expect(await publishIssue(publisher, draftId, { expectedVersion: 99 })).toMatchObject({
      number: 100,
    });
    expect(posts()).toHaveLength(1);
    const entries = await db().select().from(audit).where(eq(audit.targetId, draftId));
    expect(entries.map((entry) => entry.action)).toContain("issue.publish");
  });
  it("creates one issue when two requests come at once", async () => {
    const { draft: draftId } = await draft();
    const both = await Promise.allSettled([
      publishIssue(publisher, draftId, { expectedVersion: 1 }),
      publishIssue(publishOnly, draftId, { expectedVersion: 1 }),
    ]);
    expect(posts()).toHaveLength(1);
    for (const entry of both)
      if (entry.status === "fulfilled")
        expect(["publishing", "published"]).toContain(entry.value.state);
    expect(await db().select().from(ticketIssues)).toHaveLength(1);
  });
  it("keeps the draft when GitHub refuses, and publishes it on the next try", async () => {
    const { draft: draftId } = await draft();
    behaviour = { create: { status: 422, created: false } };
    const refused = await publishIssue(publisher, draftId, { expectedVersion: 1 });
    expect(refused).toMatchObject({ state: "failed", errorCode: "http_422", version: 2 });
    expect(await db().select().from(ticketIssues)).toHaveLength(0);
    behaviour = {};
    const retried = await publishIssue(publisher, draftId, { expectedVersion: 2 });
    expect(retried).toMatchObject({ state: "published", number: 100 });
    expect(posts()).toHaveLength(2);
  });
  it("does not repeat a publication whose outcome is unknown, and finds the issue by its marker", async () => {
    const { id, draft: draftId } = await draft();
    // GitHub created the issue and the answer was lost.
    behaviour = { create: { status: 502, created: true } };
    const unknown = await publishIssue(publisher, draftId, { expectedVersion: 1 });
    expect(unknown).toMatchObject({ state: "uncertain", errorCode: "unknown_outcome" });
    behaviour = {};
    await expect(publishIssue(publisher, draftId, { expectedVersion: 2 })).rejects.toMatchObject({
      status: 409,
    });
    await expect(discardIssueDraft(editor, draftId)).rejects.toMatchObject({ status: 409 });
    expect(posts()).toHaveLength(1);
    await expect(reconcileIssueDraft(editor, draftId)).rejects.toMatchObject({ status: 403 });
    await expect(
      reconcileIssueDraft({ ...publisher, kind: "agent" }, draftId),
    ).rejects.toMatchObject({ status: 403 });
    const found = await reconcileIssueDraft(publisher, draftId);
    expect(found).toMatchObject({ state: "published", number: 100 });
    expect((await listIssues(reader, id)).links).toEqual([
      expect.objectContaining({ number: 100, origin: "created" }),
    ]);
    expect(posts()).toHaveLength(1);
    // Nothing is left to look up.
    await expect(reconcileIssueDraft(publisher, draftId)).rejects.toMatchObject({ status: 409 });
  });
  it("finds its issue by the marker among others, and not in a pull request", async () => {
    const { draft: draftId } = await draft();
    seed("acme/app", "Unrelated", "No marker here");
    store.push({
      number: 500,
      title: "A pull request with the marker",
      body: `text <!-- aidesk-draft:${draftId} -->`,
      state: "open",
      repository: "acme/app",
      pull: true,
    });
    behaviour = { create: { status: 504, created: false } };
    expect(await publishIssue(publisher, draftId, { expectedVersion: 1 })).toMatchObject({
      state: "uncertain",
    });
    behaviour = {};
    // The others do not match, so nothing was created.
    expect(await reconcileIssueDraft(publisher, draftId)).toMatchObject({ state: "failed" });
    behaviour = { create: { status: 502, created: true } };
    const [row] = await db().select().from(issueDrafts).where(eq(issueDrafts.id, draftId));
    expect(await publishIssue(publisher, draftId, { expectedVersion: row?.version })).toMatchObject(
      { state: "uncertain" },
    );
    behaviour = {};
    expect(await reconcileIssueDraft(publisher, draftId)).toMatchObject({ state: "published" });
    expect((await db().select().from(ticketIssues))[0]?.number).not.toBe(500);
  });
  it("allows another try only after the repository was looked at and had no such issue", async () => {
    const { draft: draftId } = await draft();
    // A transport failure: the request may not have arrived.
    const unreachable = await publishIssue(
      publisher,
      draftId,
      { expectedVersion: 1 },
      {
        fetch: () => Promise.reject(new TypeError("fetch failed")),
      },
    );
    expect(unreachable).toMatchObject({ state: "uncertain" });
    const timeout = await db().select().from(issueDrafts).where(eq(issueDrafts.id, draftId));
    expect(timeout[0]?.state).toBe("uncertain");
    const none = await reconcileIssueDraft(publisher, draftId);
    expect(none).toMatchObject({ state: "failed", number: null });
    const [row] = await db().select().from(issueDrafts).where(eq(issueDrafts.id, draftId));
    expect(row).toMatchObject({ state: "failed", errorCode: "not_found_after_check" });
    const again = await publishIssue(publisher, draftId, { expectedVersion: row?.version });
    expect(again).toMatchObject({ state: "published", number: 100 });
    expect(posts()).toHaveLength(1);
  });
  it("looks up a publication that was left in progress after a crash, but not one that has just started", async () => {
    const { draft: draftId } = await draft();
    await db().update(issueDrafts).set({ state: "publishing" }).where(eq(issueDrafts.id, draftId));
    await expect(reconcileIssueDraft(publisher, draftId)).rejects.toMatchObject({ status: 409 });
    await db()
      .update(issueDrafts)
      .set({ updatedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(issueDrafts.id, draftId));
    expect(await reconcileIssueDraft(publisher, draftId)).toMatchObject({ state: "failed" });
    // A repository that cannot be read is no answer: the state stays.
    await db().update(issueDrafts).set({ state: "uncertain" }).where(eq(issueDrafts.id, draftId));
    await expect(
      reconcileIssueDraft(publisher, draftId, { fetch: () => Promise.reject(new TypeError("x")) }),
    ).rejects.toMatchObject({ status: 502 });
    const [row] = await db().select().from(issueDrafts).where(eq(issueDrafts.id, draftId));
    expect(row?.state).toBe("uncertain");
  });
});
describe("the requests to GitHub", () => {
  it("carry the token without following a redirect, wait for a limited time and check the host again", async () => {
    const found = seed("acme/app", "Grey pages");
    const id = await ticket();
    await linkIssue(editor, id, { repository: "acme/app", number: found?.number });
    const inits: RequestInit[] = [];
    await refreshIssues(reader, id, {
      fetch: (_url, init) => {
        inits.push(init ?? {});
        return Promise.resolve(new Response("{}", { status: 404 }));
      },
    });
    expect(inits[0]?.redirect).toBe("manual");
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    // A connection that is not a development one is held to the rules of hosts.
    await db()
      .update(connections)
      .set({
        config: {
          repositories: ["acme/app", "acme/docs"],
          endpoint: "https://169.254.169.254/api",
        },
      })
      .where(eq(connections.id, connectionId));
    let asked = 0;
    try {
      const view = await refreshIssues(reader, id, {
        fetch: () => {
          asked += 1;
          return Promise.resolve(new Response("{}"));
        },
      });
      expect(view.links[0]?.refreshError).toBe("host_refused");
      expect(asked).toBe(0);
    } finally {
      await db()
        .update(connections)
        .set({
          config: {
            repositories: ["acme/app", "acme/docs"],
            endpoint: origin,
            developmentOnly: true,
          },
        })
        .where(eq(connections.id, connectionId));
    }
  });
});
describe("the state of linked issues", () => {
  it("is read again, and closing an issue leaves the ticket as it is", async () => {
    const found = seed("acme/app", "Grey pages");
    const id = await ticket();
    await linkIssue(editor, id, { repository: "acme/app", number: found?.number });
    if (found) {
      found.state = "closed";
      found.title = "Grey pages (fixed)";
    }
    const view = await refreshIssues(reader, id);
    expect(view.links[0]).toMatchObject({
      state: "closed",
      title: "Grey pages (fixed)",
      refreshError: null,
    });
    const [same] = await db().select().from(tickets).where(eq(tickets.id, id));
    expect(same).toMatchObject({ status: "open", revision: 1 });
    expect(same?.pendingSince).not.toBeNull();
  });
  it("keeps the last known state and says why when it cannot be read", async () => {
    const found = seed("acme/app", "Grey pages");
    const id = await ticket();
    await linkIssue(editor, id, { repository: "acme/app", number: found?.number });
    behaviour = { read: { status: 500 } };
    expect((await refreshIssues(reader, id)).links[0]).toMatchObject({
      state: "open",
      refreshError: "http_500",
    });
    const view = await refreshIssues(reader, id, {
      fetch: () => Promise.reject(new TypeError("x")),
    });
    expect(view.links[0]).toMatchObject({ state: "open", refreshError: "unreachable" });
    behaviour = {};
    expect((await refreshIssues(reader, id)).links[0]?.refreshError).toBeNull();
    await db()
      .update(connections)
      .set({ status: "disabled" })
      .where(eq(connections.id, connectionId));
    expect((await refreshIssues(reader, id)).links[0]?.refreshError).toBe("source_not_ready");
    await db().update(connections).set({ status: "ready" }).where(eq(connections.id, connectionId));
    await expect(refreshIssues(stranger, id)).rejects.toMatchObject({ status: 404 });
  });
  it("is reconciled in the background for tickets that are not resolved or in junk, oldest first, and not too often", async () => {
    const found = seed("acme/app", "Grey pages");
    const open = await ticket();
    const resolved = await ticket(projectId, { status: "resolved", pendingSince: null });
    const junk = await ticket(projectId, { junkAt: new Date() });
    const link = async (id: string) => {
      await db()
        .insert(ticketIssues)
        .values({
          ticketId: id,
          projectId,
          connectionId,
          repository: "acme/app",
          number: found?.number ?? 0,
          url: "https://github.example/acme/app/issues/7",
          title: "Old title",
          state: "open",
          linkedBy: "x",
        });
    };
    for (const id of [open, resolved, junk]) await link(id);
    if (found) found.state = "closed";
    const now = new Date();
    expect(await reconcileIssues(now)).toBe(1);
    const states = async (id: string) =>
      (await db().select().from(ticketIssues).where(eq(ticketIssues.ticketId, id)))[0];
    expect(await states(open)).toMatchObject({ state: "closed", title: "Grey pages" });
    expect(await states(resolved)).toMatchObject({ state: "open", title: "Old title" });
    expect(await states(junk)).toMatchObject({ state: "open" });
    // Not again before the interval has passed, and then again.
    expect(await reconcileIssues(new Date(now.getTime() + 60_000))).toBe(0);
    expect(await reconcileIssues(new Date(now.getTime() + 16 * 60_000))).toBe(1);
    // The limit of a pass.
    await db().update(ticketIssues).set({ refreshedAt: null });
    const many = await ticket();
    await link(many);
    expect(await reconcileIssues(new Date(now.getTime() + 60 * 60_000), {}, 1)).toBe(1);
  });
});
describe("what the customer sees", () => {
  it("holds nothing about issues", async () => {
    const found = seed("acme/app", "Grey pages");
    const id = await ticket();
    await linkIssue(editor, id, { repository: "acme/app", number: found?.number });
    const { token } = await issuePortalGrant(
      person([...base, "ticket.reply"], `portal-${projectId}`),
      id,
    );
    const text = JSON.stringify(await getPortalTicket(token, "en"));
    for (const hidden of ["github.example", "acme/app", "Grey pages", "issue"])
      expect(text).not.toContain(hidden);
  });
});
