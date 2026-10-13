import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { z } from "zod";
import { db, sqlClient } from "../src/server/db";
import { agents, audit, configChanges, projects, tickets } from "../src/server/db/schema";
import { mcpRequest } from "../src/server/mcp";
import { tokenHash } from "../src/server/principal";
import { routes } from "../src/server/api/routes";
import type { Action } from "../src/domain/permissions";
const projectId = randomUUID();
const ticketId = randomUUID();
const tokens = new Map<string, string>();
async function token(name: string, held: Action[]) {
  const value = `aidesk_${randomBytes(16).toString("hex")}`;
  tokens.set(name, value);
  const [agent] = await db()
    .insert(agents)
    .values({
      name,
      projectId,
      actions: held,
      tokenHash: tokenHash(value),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: agents.id });
  return { value, id: agent?.id ?? "" };
}
async function rpc(bearer: string, method: string, params?: unknown) {
  const headers = {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-03-26",
  };
  const send = (body: unknown) =>
    mcpRequest(
      new Request("http://localhost:3000/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  await send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  const response = await send({
    jsonrpc: "2.0",
    id: 2,
    method,
    ...(params === undefined ? {} : { params }),
  });
  return (await response.json()) as { result: Record<string, any> };
}
const names = async (bearer: string) =>
  z
    .object({ tools: z.array(z.object({ name: z.string() })) })
    .parse((await rpc(bearer, "tools/list")).result)
    .tools.map((tool) => tool.name);
const call = async (bearer: string, name: string, args: unknown) => {
  const { result } = await rpc(bearer, "tools/call", { name, arguments: args });
  const text = String((result.content as { text: string }[])[0]?.text);
  let body: Record<string, any>;
  try {
    body = JSON.parse(text) as Record<string, any>;
  } catch {
    body = { text };
  }
  return { isError: result.isError === true, body };
};
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values({ id: projectId, name: "MCP tools", slug: `mcp-${projectId}` });
  await db().insert(tickets).values({
    id: ticketId,
    projectId,
    subject: "MCP",
    requesterEmail: "kim@example.test",
    requesterName: "Kim",
    language: "en",
  });
});
afterAll(async () => {
  await db().delete(configChanges).where(eq(configChanges.projectId, projectId));
  await db()
    .delete(audit)
    .where(inArray(audit.projectId, [projectId]));
  await db().delete(agents).where(eq(agents.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await sqlClient().end();
});
describe("the route table and MCP", () => {
  it("states for every route how it reaches MCP, with unique tool names that exist", () => {
    const source = readFileSync("src/server/mcp.ts", "utf8");
    const seen = new Set<string>();
    for (const route of routes) {
      const offer = route.mcp as { tool?: string; legacy?: string; not?: string };
      const name = offer.tool ?? offer.legacy;
      if (name === undefined) {
        expect(offer.not?.length, route.id).toBeGreaterThan(10);
        continue;
      }
      expect(seen.has(name), `${route.id}: ${name} twice`).toBe(false);
      seen.add(name);
      // A legacy tool is registered by hand in mcp.ts.
      if (offer.legacy) expect(source).toContain(`"${offer.legacy}"`);
      // Only routes for a caller who holds an action in a project can be tools.
      expect(["owner", "human", "any"]).not.toContain(route.access);
    }
    // Nothing that issues credentials, decides or moves mail to junk is offered.
    for (const id of [
      "agents.issue",
      "config.decide",
      "tickets.portal_link",
      "tickets.junk",
      "operators.grant",
    ])
      expect(routes.find((route) => route.id === id)?.mcp).toHaveProperty("not");
  });
});
describe("the tools of an agent", () => {
  it("are the ones its actions allow", async () => {
    const reader = await token("reader", ["project.read", "ticket.read"]);
    const configurator = await token("configurator", [
      "project.read",
      "config.read",
      "config.write",
      "integration.manage",
    ]);
    const worker = await token("worker", [
      "project.read",
      "ticket.read",
      "ticket.resolve",
      "ticket.assign",
      "ticket.note",
    ]);
    const readerTools = await names(reader.value);
    expect(readerTools).toContain("overview_get");
    for (const hidden of [
      "config_get",
      "config_put",
      "connections_list",
      "texts_set",
      "tickets_set_status",
      "tickets_assign",
      "tickets_set_tags",
    ])
      expect(readerTools).not.toContain(hidden);
    const configTools = await names(configurator.value);
    for (const shown of [
      "config_get",
      "config_put",
      "config_changes",
      "connections_list",
      "connections_create",
      "connections_update",
      "connections_disable",
      "connections_test",
      "texts_list",
      "texts_set",
      "texts_versions",
    ])
      expect(configTools).toContain(shown);
    expect(configTools).not.toContain("tickets_list");
    expect(configTools).not.toContain("config_decide");
    const workTools = await names(worker.value);
    for (const shown of ["tickets_set_status", "tickets_assign", "tickets_set_tags"])
      expect(workTools).toContain(shown);
  });
  it("read and change the configuration as REST does, and a proposal says it is one", async () => {
    const { value } = await token("config-agent", ["project.read", "config.read", "config.write"]);
    const read = await call(value, "config_get", { projectId });
    expect(read.isError).toBe(false);
    expect(read.body).toMatchObject({ version: 1, config: { approvalPolicy: "review" } });
    const proposed = await call(value, "config_put", {
      projectId,
      config: { ...read.body.config, color: "#123456" },
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    expect(proposed).toMatchObject({ isError: false, body: { outcome: "proposed" } });
    expect((await call(value, "config_get", { projectId })).body.config.color).not.toBe("#123456");
    const changes = await call(value, "config_changes", { projectId, status: "pending" });
    expect(changes.body).toHaveLength(1);
    // The agent cannot decide, and no tool offers it.
    expect(await names(value)).not.toContain("config_decide");
    const checked = await call(value, "config_put", {
      projectId,
      config: { ...read.body.config, color: "#654321" },
      expectedVersion: 1,
      validate: true,
    });
    expect(checked.body).toMatchObject({ outcome: "proposed", validated: true });
  });
  it("answer an invalid call with the field, and a call without the right as an error", async () => {
    const { value } = await token("config-writer", ["project.read", "config.read", "config.write"]);
    const bad = await call(value, "texts_set", {
      projectId,
      key: "acknowledgement",
      language: "de",
      text: "no placeholder",
      expectedVersion: 0,
    });
    expect(bad.isError).toBe(true);
    expect(bad.body).toMatchObject({ error: "invalid_input", issues: [{ pointer: "/text" }] });
    const reader = await token("config-reader", ["project.read", "config.read"]);
    const refused = await call(reader.value, "texts_set", {
      projectId,
      key: "acknowledgement",
      language: "de",
      text: "x #{number}",
      expectedVersion: 0,
    });
    // The tool does not exist for this agent; the server answers with its own error.
    expect(refused.isError).toBe(true);
    expect(String(refused.body.text)).toContain("not found");
  });
  it("set tags, resolve, reopen and assign tickets", async () => {
    const worker = await token("ticket-worker", [
      "project.read",
      "ticket.read",
      "ticket.note",
      "ticket.resolve",
      "ticket.assign",
    ]);
    const other = await token("assignee", ["project.read", "ticket.read", "ticket.reply"]);
    expect(
      (await call(worker.value, "tickets_set_tags", { ticketId, tags: ["from-mcp"] })).body,
    ).toEqual({ tags: ["from-mcp"] });
    const detail = await call(worker.value, "tickets_get", { ticketId });
    const revision = detail.body.ticket.revision as number;
    const resolved = await call(worker.value, "tickets_set_status", {
      ticketId,
      status: "resolved",
      expectedRevision: revision,
    });
    expect(resolved.body).toMatchObject({
      status: "resolved",
      revision: revision + 1,
      changed: true,
    });
    expect(
      (
        await call(worker.value, "tickets_set_status", {
          ticketId,
          status: "resolved",
          expectedRevision: revision + 1,
        })
      ).body,
    ).toMatchObject({ changed: false });
    expect(
      (
        await call(worker.value, "tickets_set_status", {
          ticketId,
          status: "open",
          expectedRevision: revision,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call(worker.value, "tickets_set_status", {
          ticketId,
          status: "open",
          expectedRevision: revision + 1,
        })
      ).body,
    ).toMatchObject({ status: "open" });
    const assigned = await call(worker.value, "tickets_assign", {
      ticketId,
      userId: null,
      agentId: other.id,
    });
    expect(assigned.body).toEqual({ assigneeUserId: null, assigneeAgentId: other.id });
    expect(
      (await call(worker.value, "tickets_assign", { ticketId, userId: null, agentId: null })).body,
    ).toEqual({ assigneeUserId: null, assigneeAgentId: null });
    const bad = await call(worker.value, "tickets_assign", {
      ticketId,
      userId: "nobody",
      agentId: null,
    });
    expect(bad).toMatchObject({ isError: true, body: { issues: [{ pointer: "/userId" }] } });
  });
});
