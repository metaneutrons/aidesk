import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isTable } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { makeSignature } from "better-auth/crypto";
import { z } from "zod";
import { auth } from "../src/server/auth";
import { initializeStorage } from "../src/server/storage";
import * as schema from "../src/server/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  agents,
  audit,
  connections,
  jobs,
  memberships,
  messages,
  projects,
  tickets,
  user,
} from "../src/server/db/schema";
import { actions, type Principal } from "../src/domain/permissions";
import {
  createOperator,
  createProject,
  getTicket,
  issueAgentToken,
  listAgentTokens,
  listOperators,
  listProjects,
  listTickets,
  operatorInfo,
  reply,
  revokeAgentToken,
  setLocale,
  setOperatorActive,
  setOperatorGrant,
} from "../src/server/operations";
import { identify, requireMutationOrigin, tokenHash } from "../src/server/principal";
import { mcpRequest } from "../src/server/mcp";
import { capabilities } from "../src/domain/capabilities";
import { GET, POST } from "../src/app/api/v1/[[...path]]/route";
const actorId = randomUUID();
const agentId = randomUUID();
const projectId = randomUUID();
const hiddenId = randomUUID();
const ticketId = randomUUID();
const hiddenTicket = randomUUID();
const connectionId = randomUUID();
const bearer = randomBytes(32).toString("hex");
const principal: Principal = {
  id: actorId,
  kind: "human",
  active: true,
  owner: true,
  grants: [{ projectId, actions: [...actions] }],
};
const extraProjects: string[] = [];
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(user)
    .values({
      id: actorId,
      name: "Test operator",
      email: `${actorId}@example.test`,
      emailVerified: true,
    });
  await db()
    .insert(projects)
    .values([
      {
        id: projectId,
        name: "Visible test",
        slug: `test-${projectId}`,
        settings: { outboundConnectionId: connectionId },
      },
      { id: hiddenId, name: "Hidden test", slug: `test-${hiddenId}` },
    ]);
  await db()
    .insert(memberships)
    .values({ userId: actorId, projectId, actions: [...actions] });
  await db()
    .insert(agents)
    .values({
      id: agentId,
      name: "Read agent",
      projectId,
      actions: ["project.read", "ticket.read"],
      tokenHash: tokenHash(bearer),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  await db().insert(connections).values({
    id: connectionId,
    projectId,
    kind: "smtp",
    name: "Test outgoing",
    direction: "outbound",
    status: "ready",
  });
  await db()
    .insert(tickets)
    .values([
      {
        id: ticketId,
        projectId,
        subject: "Visible",
        requesterName: "Customer",
        requesterEmail: "customer@example.test",
        pendingSince: new Date(),
      },
      {
        id: hiddenTicket,
        projectId: hiddenId,
        subject: "Private",
        requesterName: "Hidden",
        requesterEmail: "private@example.test",
        pendingSince: new Date(),
      },
    ]);
  await db().insert(messages).values({
    ticketId,
    authorType: "customer",
    authorName: "Customer",
    markdown: "**Question**",
    language: "en",
  });
});
afterAll(async () => {
  const ids = [projectId, hiddenId, ...extraProjects];
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(connections).where(inArray(connections.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await db().delete(user).where(eq(user.id, actorId));
  await sqlClient().end();
});
describe("persistent project boundaries", () => {
  it("filters lists before data leaves the server and denies guessed resources", async () => {
    expect((await listProjects(principal)).map((value) => value.id)).toEqual([projectId]);
    expect((await listTickets(principal, [projectId])).map((value) => value.id)).toEqual([
      ticketId,
    ]);
    expect(await listTickets({ ...principal, grants: [] })).toEqual([]);
    expect(await listProjects({ ...principal, grants: [] })).toEqual([]);
    await expect(listTickets(principal, [hiddenId])).rejects.toMatchObject({ code: "not_found" });
    await expect(getTicket(principal, hiddenTicket)).rejects.toMatchObject({ code: "not_found" });
    await expect(getTicket({ ...principal, grants: [] }, ticketId)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await getTicket(principal, ticketId)).messages[0]?.html).toContain(
      "<strong>Question</strong>",
    );
    expect(await getTicket(principal, ticketId)).toMatchObject({
      sender: null,
      recipients: [{ name: "Customer", address: "customer@example.test" }],
    });
    await db()
      .update(connections)
      .set({ config: { from: "support@example.test", password: "never-exposed" } })
      .where(eq(connections.id, connectionId));
    const identified = await getTicket(principal, ticketId);
    expect(identified.sender).toEqual({ name: "Visible test", address: "support@example.test" });
    expect(JSON.stringify(identified)).not.toContain("never-exposed");
    await db().update(connections).set({ config: {} }).where(eq(connections.id, connectionId));
    expect(
      (
        await getTicket(
          { ...principal, grants: [{ projectId, actions: ["ticket.read"] }] },
          ticketId,
        )
      ).actions,
    ).toEqual(["ticket.read"]);
  });
  it("explains a reply in review and nothing else", async () => {
    const [review, sent] = await db()
      .insert(schema.messages)
      .values([
        {
          ticketId,
          authorType: "human",
          authorName: "Agent",
          markdown: "Blocked reply",
          language: "en",
          deliveryState: "review",
          source: { deliveryError: "recipient_suppressed" },
        },
        {
          ticketId,
          authorType: "human",
          authorName: "Agent",
          markdown: "Delivered later",
          language: "en",
          deliveryState: "sent",
          source: { deliveryError: "transport_acceptance_unknown" },
        },
      ])
      .returning({ id: schema.messages.id });
    const shown = (await getTicket(principal, ticketId)).messages;
    expect(shown.find((message) => message.id === review?.id)?.deliveryError).toBe(
      "recipient_suppressed",
    );
    expect(shown.find((message) => message.id === sent?.id)?.deliveryError).toBeNull();
    expect(shown.filter((message) => message.deliveryState === "received")).not.toHaveLength(0);
    expect(
      shown.filter((message) => message.deliveryState !== "review").map((m) => m.deliveryError),
    ).toEqual(shown.filter((message) => message.deliveryState !== "review").map(() => null));
    await db()
      .delete(schema.messages)
      .where(inArray(schema.messages.id, [review?.id ?? "", sent?.id ?? ""]));
  });
  it("creates projects with an explicit creator grant and audit", async () => {
    for (const changed of [
      { ...principal, owner: false },
      { ...principal, active: false },
      { ...principal, kind: "agent" as const },
    ])
      await expect(createProject(changed, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(createProject(principal, { name: "", slug: "bad slug" })).rejects.toThrow();
    const created = await createProject(principal, {
      name: "Created",
      slug: `test-${randomUUID()}`,
      defaultLanguage: "de",
    });
    extraProjects.push(created.id);
    const [grant] = await db()
      .select()
      .from(memberships)
      .where(eq(memberships.projectId, created.id));
    expect(grant?.actions).toEqual([...actions]);
    const [record] = await db().select().from(audit).where(eq(audit.targetId, created.id));
    expect(record?.action).toBe("project.create");
  });
  it("persists UI locale without changing ticket communication language", async () => {
    await setLocale(principal, { locale: "de" });
    expect((await operatorInfo(principal)).locale).toBe("de");
    expect((await getTicket(principal, ticketId)).ticket.language).toBe("en");
    await expect(
      setLocale({ ...principal, kind: "agent" }, { locale: "en" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await operatorInfo({ ...principal, kind: "agent" })).locale).toBeNull();
    await setLocale(principal, { locale: null });
    expect((await operatorInfo(principal)).locale).toBeNull();
    await expect(setLocale(principal, { locale: "fr" })).rejects.toThrow();
    await expect(operatorInfo({ ...principal, id: randomUUID() })).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });
});
describe("durable replies and private notes", () => {
  it("requires permissions, valid direction, language and fresh revision", async () => {
    const input = {
      markdown: "Answer",
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      language: "en",
    };
    const reader = { ...principal, grants: [{ projectId, actions: ["ticket.read"] as const }] };
    await expect(reply(reader, ticketId, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(reply(reader, ticketId, { ...input, internal: true })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      reply(principal, ticketId, { ...input, internal: true, resolve: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(reply(principal, ticketId, { ...input, language: "de" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      reply(principal, ticketId, { ...input, expectedRevision: 999 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await db().update(projects).set({ settings: {} }).where(eq(projects.id, projectId));
    await expect(reply(principal, ticketId, input)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await db()
      .update(projects)
      .set({ settings: { outboundConnectionId: connectionId } })
      .where(eq(projects.id, projectId));
  });
  it("atomically records a note and exactly one queued response without resetting the clock", async () => {
    const start = (await getTicket(principal, ticketId)).ticket.pendingSince;
    const noteInput = {
      markdown: "Private diagnostic",
      internal: true,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      language: "en",
    };
    const note = await reply(principal, ticketId, noteInput);
    expect(note.duplicate).toBe(false);
    expect(await reply(principal, ticketId, noteInput)).toMatchObject({
      id: note.id,
      duplicate: true,
    });
    await expect(
      reply(principal, ticketId, { ...noteInput, markdown: "Changed" }),
    ).rejects.toMatchObject({ code: "conflict" });
    const responseInput = {
      markdown: "Public answer",
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
      language: "en",
    };
    const response = await reply(principal, ticketId, responseInput);
    expect((await getTicket(principal, ticketId)).ticket.pendingSince).toEqual(start);
    const records = await db().select().from(jobs).where(eq(jobs.projectId, projectId));
    expect(records.filter((record) => record.type === "mail.send")).toHaveLength(1);
    expect(records.find((record) => record.payload.messageId === response.id)?.status).toBe(
      "queued",
    );
    const agent: Principal = {
      id: agentId,
      kind: "agent",
      active: true,
      owner: false,
      grants: [{ projectId, actions: [...actions] }],
    };
    await reply(agent, ticketId, {
      markdown: "Agent private note",
      internal: true,
      expectedRevision: 3,
      idempotencyKey: randomUUID(),
      language: "en",
    });
    const [noteRecord] = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.ticketId, ticketId), eq(messages.authorType, "agent")));
    expect(noteRecord?.authorName).toBe("Agent");
  });
});
describe("authenticated API and MCP principal", () => {
  it("enforces scopes and strict paths at the REST entry point", async () => {
    const headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
    const get = (path: string) =>
      GET(new Request(`http://localhost:3000/api/v1/${path}`, { headers }));
    expect((await get("projects")).status).toBe(200);
    expect((await get(`tickets/${hiddenTicket}`)).status).toBe(404);
    expect((await get(`tickets?project=${hiddenId}`)).status).toBe(404);
    expect((await get("projects/extra")).status).toBe(404);
    expect((await get(`tickets/${ticketId}/extra`)).status).toBe(404);
    expect((await get("tickets/not-a-uuid")).status).toBe(400);
    expect((await GET(new Request("http://localhost:3000/api/v1/projects"))).status).toBe(401);
    // Mail design routes: an agent token reads and previews, never changes or sends.
    const post = (path: string, body: object = {}) =>
      POST(
        new Request(`http://localhost:3000/api/v1/${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      );
    expect((await get(`projects/${projectId}/designs`)).status).toBe(200);
    expect((await post(`projects/${projectId}/designs/preview`)).status).toBe(200);
    expect((await post(`projects/${projectId}/designs`, {})).status).toBe(403);
    expect((await post(`projects/${projectId}/designs/select`, { version: 0 })).status).toBe(403);
    expect((await post(`projects/${projectId}/designs/test`)).status).toBe(403);
    expect((await post(`projects/${projectId}/designs/unknown`)).status).toBe(404);
    expect((await post(`projects/${projectId}/designs/preview/extra`)).status).toBe(404);
    expect((await get(`projects/${projectId}/designs/extra`)).status).toBe(404);
    expect((await get(`projects/${hiddenId}/designs`)).status).toBe(404);
    expect((await post(`projects/${hiddenId}/designs/preview`)).status).toBe(404);
    expect((await get(`test-mails/${randomUUID()}`)).status).toBe(404);
    expect((await get("test-mails/not-a-uuid")).status).toBe(400);
    // Portal links: an agent token never opens customer access.
    expect((await post(`tickets/${ticketId}/portal-link`)).status).toBe(403);
    expect((await post(`tickets/${ticketId}/portal-link/revoke`)).status).toBe(403);
    // An agent is refused before the ticket is looked up, so a hidden one is not revealed.
    expect((await post(`tickets/${hiddenTicket}/portal-link`)).status).toBe(403);
    expect((await post(`tickets/${ticketId}/portal-link/extra`)).status).toBe(404);
    expect((await get(`tickets/${ticketId}/portal-link`)).status).toBe(404);
    const denied = await POST(
      new Request(`http://localhost:3000/api/v1/tickets/${ticketId}/reply`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          markdown: "Denied",
          expectedRevision: 4,
          idempotencyKey: randomUUID(),
          language: "en",
        }),
      }),
    );
    expect(denied.status).toBe(403);
    expect(
      (
        await POST(
          new Request("http://localhost:3000/api/v1/projects", {
            method: "POST",
            headers,
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          new Request("http://localhost:3000/api/v1/me/locale", {
            method: "POST",
            headers,
            body: "{broken",
          }),
        )
      ).status,
    ).toBe(400);
  });
  it("validates scoped, active, unexpired bearer credentials", async () => {
    const agent = await identify(new Headers({ authorization: `Bearer ${bearer}` }));
    expect(agent.id).toBe(agentId);
    expect(agent.owner).toBe(false);
    expect((await listProjects(agent)).map((project) => project.id)).toEqual([projectId]);
    for (const authorization of ["Basic nope", "Bearer invalid"])
      await expect(identify(new Headers({ authorization }))).rejects.toMatchObject({
        code: "unauthenticated",
      });
    await expect(identify(new Headers())).rejects.toMatchObject({ code: "unauthenticated" });
    await db().update(agents).set({ active: false }).where(eq(agents.id, agentId));
    await expect(
      identify(new Headers({ authorization: `Bearer ${bearer}` })),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await db()
      .update(agents)
      .set({ active: true, expiresAt: new Date(0) })
      .where(eq(agents.id, agentId));
    await expect(
      identify(new Headers({ authorization: `Bearer ${bearer}` })),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await db()
      .update(agents)
      .set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(agents.id, agentId));
  });
  it("protects cookie mutations against cross-origin requests", () => {
    expect(() => {
      requireMutationOrigin(
        new Request("http://localhost:3000/api/v1/projects", {
          headers: { origin: "http://localhost:3000" },
        }),
      );
    }).not.toThrow();
    expect(() => {
      requireMutationOrigin(new Request("http://localhost:3000/api/v1/projects"));
    }).toThrow("forbidden");
    expect(() => {
      requireMutationOrigin(
        new Request("http://localhost:3000/api/v1/projects", {
          headers: { origin: "https://evil.test" },
        }),
      );
    }).toThrow("forbidden");
    expect(() => {
      requireMutationOrigin(
        new Request("http://localhost:3000/api/v1/projects", {
          headers: { authorization: "Bearer verified-by-identify" },
        }),
      );
    }).not.toThrow();
  });
  it("answers MCP initialization and hides unauthorized tools", async () => {
    const headers = {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    };
    const request = (body: unknown, changes = {}) =>
      new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers: { ...headers, ...changes },
        body: JSON.stringify(body),
      });
    const initialized = await mcpRequest(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "qualification", version: "1" },
        },
      }),
    );
    expect(initialized.status).toBe(200);
    const response = await mcpRequest(request({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const body = z
      .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
      .parse(await response.json());
    // The hand-written tools first, then the ones the route table offers for the
    // actions this agent holds (project.read and ticket.read).
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "projects_list",
      "tickets_list",
      "tickets_search",
      "tickets_get",
      "tags_list",
      "overview_get",
      "tickets_agent_runs",
    ]);
    for (const [name, args] of [
      ["projects_list", {}],
      ["tickets_list", { projectIds: [projectId] }],
      ["tickets_search", { query: "ticket" }],
      ["tickets_get", { ticketId }],
    ] as const) {
      const called = await mcpRequest(
        request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }),
      );
      expect(called.status).toBe(200);
      const result = await called.json();
      expect(result.result.isError).not.toBe(true);
    }
    await db()
      .update(agents)
      .set({ actions: [...actions] })
      .where(eq(agents.id, agentId));
    const writing = await mcpRequest(
      request({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "tickets_reply",
          arguments: {
            ticketId,
            markdown: "MCP internal analysis",
            internal: true,
            expectedRevision: 4,
            idempotencyKey: randomUUID(),
            language: "en",
          },
        },
      }),
    );
    expect((await writing.json()).result.isError).not.toBe(true);
    expect((await mcpRequest(request({}, { authorization: "" }))).status).toBe(401);
    expect((await mcpRequest(request({}, { origin: "https://evil.test" }))).status).toBe(403);
    expect(capabilities["tickets.reply"].action).toBe("ticket.reply");
  });
  it("rechecks human project grants and account revocation on every session request", async () => {
    const context = await auth().$context;
    const session = await context.internalAdapter.createSession(actorId);
    expect(session).not.toBeNull();
    const signature = await makeSignature(session.token, context.secret);
    const headers = new Headers({
      cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
    });
    expect((await identify(headers)).grants.map((grant) => grant.projectId).sort()).toEqual(
      [projectId, ...extraProjects].sort(),
    );
    await db().update(memberships).set({ actions: [] }).where(eq(memberships.userId, actorId));
    expect(await listProjects(await identify(headers))).toEqual([]);
    await db().update(user).set({ active: false }).where(eq(user.id, actorId));
    await expect(identify(headers)).rejects.toMatchObject({ code: "unauthenticated" });
    await db().update(user).set({ active: true }).where(eq(user.id, actorId));
  });
});
describe("persistence and private storage", () => {
  it("defines primary identities and enforces uniqueness at the database", async () => {
    type PersistentTable = Extract<(typeof schema)[keyof typeof schema], PgTable>;
    const tables = Object.values(schema).filter((value): value is PersistentTable =>
      isTable(value),
    );
    expect(tables.length).toBeGreaterThan(10);
    for (const table of tables) {
      const config = getTableConfig(table);
      expect(config.columns.some((column) => column.primary)).toBe(true);
      for (const foreignKey of config.foreignKeys)
        expect(foreignKey.reference().foreignColumns.every((column) => column.primary)).toBe(true);
    }
    await expect(
      db().insert(memberships).values({ userId: actorId, projectId, actions: [] }),
    ).rejects.toThrow();
  });
  it("encrypts SSO configuration at rest and decrypts only in the server adapter", async () => {
    const providerId = `test-${randomUUID()}`;
    const configuration = JSON.stringify({ clientSecret: "fake-provider-secret" });
    await db().insert(schema.ssoProvider).values({
      id: providerId,
      issuer: "https://issuer.example.test",
      providerId,
      domain: "example.test",
      oidcConfig: configuration,
      samlConfig: configuration,
    });
    try {
      const [row] = await db()
        .select()
        .from(schema.ssoProvider)
        .where(eq(schema.ssoProvider.id, providerId));
      expect(row?.oidcConfig).toBe(configuration);
      expect(row?.samlConfig).toBe(configuration);
      const raw = await sqlClient()`select oidc_config from sso_provider where id = ${providerId}`;
      expect(raw[0]?.oidc_config).not.toContain("fake-provider-secret");
    } finally {
      await db().delete(schema.ssoProvider).where(eq(schema.ssoProvider.id, providerId));
    }
  });
  it("creates missing private buckets without treating authorization or service errors as absence", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    try {
      send.mockResolvedValueOnce(undefined);
      await initializeStorage();
      expect(send).toHaveBeenCalledTimes(1);
      send
        .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
        .mockResolvedValueOnce(undefined);
      await initializeStorage();
      expect(send.mock.calls[2]?.[0]).toBeInstanceOf(CreateBucketCommand);
      const denied = { $metadata: { httpStatusCode: 403 } };
      // Another process created the bucket between the check and the creation.
      for (const name of ["BucketAlreadyOwnedByYou", "BucketAlreadyExists"])
        send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } }).mockRejectedValueOnce({
          name,
          $metadata: { httpStatusCode: 409 },
        });
      await initializeStorage();
      await initializeStorage();
      // Any other failure of the creation is still an error.
      send
        .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
        .mockRejectedValueOnce(denied);
      await expect(initializeStorage()).rejects.toEqual(denied);
      send
        .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
        .mockRejectedValueOnce(new Error("BucketAlreadyOwnedByYou"));
      await expect(initializeStorage()).rejects.toThrow("BucketAlreadyOwnedByYou");
      send.mockRejectedValueOnce(denied);
      await expect(initializeStorage()).rejects.toEqual(denied);
      send.mockRejectedValueOnce(new Error("service_unavailable"));
      await expect(initializeStorage()).rejects.toThrow("service_unavailable");
    } finally {
      send.mockRestore();
    }
  });
});
describe("project-scoped agent tokens", () => {
  it("issues tokens within the issuer's own grant and revokes them", async () => {
    const issued = await issueAgentToken(principal, projectId, {
      name: "Remote client",
      actions: ["project.read", "ticket.read", "ticket.read"],
      expiresInDays: 7,
    });
    expect(issued.token).toMatch(/^aidesk_[A-Za-z0-9_-]{43}$/);
    expect(issued.actions).toEqual(["project.read", "ticket.read"]);
    expect(issued.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    const agent = await identify(new Headers({ authorization: `Bearer ${issued.token}` }));
    expect(agent).toMatchObject({
      kind: "agent",
      grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
    });
    const listed = await listAgentTokens(principal, projectId);
    expect(listed.find((entry) => entry.id === issued.id)).toMatchObject({ active: true });
    expect(JSON.stringify(listed)).not.toContain(issued.token);
    expect(JSON.stringify(listed)).not.toContain(tokenHash(issued.token));
    await expect(listAgentTokens(agent, projectId)).rejects.toMatchObject({ code: "not_found" });
    await expect(revokeAgentToken(agent, issued.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await revokeAgentToken(principal, issued.id)).toEqual({ revoked: true });
    await expect(
      identify(new Headers({ authorization: `Bearer ${issued.token}` })),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    const logged = await db()
      .select({ action: schema.audit.action })
      .from(schema.audit)
      .where(eq(schema.audit.targetId, issued.id));
    expect(logged.map((entry) => entry.action).sort()).toEqual(["agent.issue", "agent.revoke"]);
    await expect(revokeAgentToken(principal, randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("refuses wider, self-managing or agent-issued tokens", async () => {
    const narrow: Principal = {
      ...principal,
      grants: [{ projectId, actions: ["project.read", "ticket.read", "agent.manage"] }],
    };
    const input = { name: "Too wide", actions: ["ticket.reply"] };
    await expect(issueAgentToken(narrow, projectId, input)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      issueAgentToken(principal, projectId, { ...input, actions: ["agent.manage"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      issueAgentToken(principal, projectId, { ...input, actions: ["not.an.action"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      issueAgentToken({ ...principal, kind: "agent" }, projectId, {
        ...input,
        actions: ["ticket.read"],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      issueAgentToken(principal, hiddenId, { ...input, actions: ["ticket.read"] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      issueAgentToken(principal, projectId, {
        ...input,
        actions: ["ticket.read"],
        expiresInDays: 365,
      }),
    ).rejects.toThrow();
  });
});
describe("operator administration", () => {
  it("lets owners create and disable operators but not owners or themselves", async () => {
    const email = `${randomUUID()}@Example.test`;
    const created = await createOperator(principal, { name: "New operator", email });
    expect(created.email).toBe(email.toLowerCase());
    await expect(createOperator(principal, { name: "Again", email })).rejects.toMatchObject({
      code: "conflict",
    });
    const nonOwner: Principal = { ...principal, owner: false };
    await expect(
      createOperator(nonOwner, { name: "X", email: "x@example.test" }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      createOperator({ ...principal, kind: "agent" }, { name: "X", email: "y@example.test" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await db()
      .insert(schema.session)
      .values({
        id: randomUUID(),
        token: randomUUID(),
        userId: created.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    expect(await setOperatorActive(principal, created.id, { active: false })).toEqual({
      id: created.id,
      active: false,
    });
    expect(
      await db().select().from(schema.session).where(eq(schema.session.userId, created.id)),
    ).toEqual([]);
    await expect(setOperatorActive(principal, actorId, { active: false })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(setOperatorActive(nonOwner, created.id, { active: true })).rejects.toMatchObject({
      code: "forbidden",
    });
    const otherOwner = randomUUID();
    await db()
      .insert(schema.user)
      .values({
        id: otherOwner,
        name: "Other owner",
        email: `${otherOwner}@example.test`,
        owner: true,
      });
    await expect(setOperatorActive(principal, otherOwner, { active: false })).rejects.toMatchObject(
      {
        code: "forbidden",
      },
    );
    await expect(
      setOperatorActive(principal, randomUUID(), { active: false }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    const actions = (
      await db()
        .select()
        .from(schema.audit)
        .where(inArray(schema.audit.targetId, [created.id]))
    ).map((entry) => entry.action);
    expect(actions.sort()).toEqual(["operator.create", "operator.disable"]);
    await db()
      .delete(schema.audit)
      .where(inArray(schema.audit.targetId, [created.id]));
    await db()
      .delete(schema.user)
      .where(inArray(schema.user.id, [created.id, otherOwner]));
  });
  it("grants project access only within the manager's own actions", async () => {
    const operator = await createOperator(principal, {
      name: "Grant target",
      email: `${randomUUID()}@example.test`,
    });
    const granted = await setOperatorGrant(principal, operator.id, {
      projectId,
      actions: ["project.read", "ticket.read", "ticket.read"],
    });
    expect(granted.actions).toEqual(["project.read", "ticket.read"]);
    const listed = await listOperators(principal);
    expect(listed.find((person) => person.id === operator.id)).toMatchObject({
      active: true,
      signIn: [],
      grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
    });
    const narrow: Principal = {
      ...principal,
      owner: false,
      grants: [{ projectId, actions: ["project.read", "ticket.read", "project.manage"] }],
    };
    await expect(
      setOperatorGrant(narrow, operator.id, { projectId, actions: ["ticket.reply"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      setOperatorGrant(principal, operator.id, { projectId: hiddenId, actions: ["ticket.read"] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      setOperatorGrant(principal, randomUUID(), { projectId, actions: ["ticket.read"] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      setOperatorGrant(principal, operator.id, { projectId, actions: ["no.such.action"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // A project manager sees only the projects they manage.
    expect(
      (
        await listOperators({
          ...narrow,
          grants: [{ projectId: hiddenId, actions: ["project.manage"] }],
        })
      ).find((person) => person.id === operator.id)?.grants,
    ).toEqual([]);
    await expect(
      listOperators({
        ...principal,
        owner: false,
        grants: [{ projectId, actions: ["ticket.read"] }],
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await setOperatorGrant(principal, operator.id, { projectId, actions: [] });
    expect(
      await db().select().from(memberships).where(eq(memberships.userId, operator.id)),
    ).toEqual([]);
    await db().delete(schema.audit).where(eq(schema.audit.targetId, operator.id));
    await db().delete(schema.user).where(eq(schema.user.id, operator.id));
  });
});
