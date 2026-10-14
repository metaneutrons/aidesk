import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
}));
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, projects } from "../src/server/db/schema";
import { handle } from "../src/server/api/router";
import type { Action, Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const person = (name: string, kind: "human" | "agent", held: Action[]): Principal => ({
  id: `${name}-${projectId}`,
  kind,
  active: true,
  owner: false,
  grants: [{ projectId, actions: held }],
});
const manager = person("manager", "human", [
  "project.read",
  "integration.manage",
  "config.read",
  "config.approve",
]);
const agent = person("agent", "agent", ["project.read", "integration.manage"]);
async function call(principal: Principal, method: string, path: string, body?: unknown) {
  const response = await handle(
    new Request(`http://localhost:3000/api/v1${path}`, {
      method,
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    principal,
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
const definition = {
  kind: "smtp",
  direction: "outbound",
  name: "Outgoing",
  config: {
    host: "smtp.example.test",
    port: 587,
    secure: false,
    from: "a@example.test",
    replyTo: "a@example.test",
  },
  secret: { user: "u", pass: "never-shown" },
};
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values({ id: projectId, name: "Connections API", slug: `connapi-${projectId}` });
});
afterAll(async () => {
  await db()
    .delete(audit)
    .where(inArray(audit.projectId, [projectId]));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectId]));
  await sqlClient().end();
});
describe("connections over REST", () => {
  it("answers with the documented statuses and never shows a secret", async () => {
    const base = `/projects/${projectId}/connections`;
    expect((await call(manager, "POST", `${base}?validate=true`, definition)).status).toBe(200);
    const created = await call(manager, "POST", base, definition);
    expect(created).toMatchObject({ status: 201, body: { outcome: "applied", version: 1 } });
    const id = created.body.connectionId as string;
    const listed = await call(manager, "GET", base);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain("never-shown");
    expect(listed.body[0]).toMatchObject({ secretSet: true, status: "draft" });
    // A person changes with 200; an agent under the review policy gets 202.
    expect(
      (await call(manager, "PUT", `${base}/${id}`, { expectedVersion: 1, name: "Renamed" })).status,
    ).toBe(200);
    const proposed = await call(agent, "PUT", `${base}/${id}`, {
      expectedVersion: 2,
      name: "By agent",
    });
    expect(proposed).toMatchObject({ status: 202, body: { outcome: "proposed" } });
    expect((await call(agent, "PUT", `${base}/${id}`, { expectedVersion: 2 })).status).toBe(200);
    expect(
      (await call(agent, "POST", `${base}/${id}/disable`, { expectedVersion: 2 })).status,
    ).toBe(202);
    expect(
      (await call(manager, "PUT", `${base}/${id}`, { expectedVersion: 1, name: "Late" })).body,
    ).toEqual({ error: "stale_version" });
    const decided = await call(
      manager,
      "POST",
      `/config/changes/${String(proposed.body.changeId)}/decision`,
      { decision: "approve" },
    );
    expect(decided).toMatchObject({ status: 200, body: { status: "applied", version: 3 } });
    const disabled = await call(manager, "POST", `${base}/${id}/disable`, { expectedVersion: 3 });
    expect(disabled).toMatchObject({ status: 200, body: { outcome: "applied", version: 4 } });
    expect((await call(manager, "POST", `${base}/${id}/test`)).status).toBe(409);
  });
  it("names the offending field and refuses an unknown kind", async () => {
    const base = `/projects/${projectId}/connections`;
    const bad = await call(manager, "POST", base, {
      ...definition,
      config: { ...definition.config, port: 25 },
    });
    expect(bad.status).toBe(400);
    expect((bad.body.issues as { pointer: string }[]).map((issue) => issue.pointer)).toContain(
      "/config/port",
    );
    const unknown = await call(manager, "POST", base, { ...definition, kind: "pigeon" });
    expect(unknown.status).toBe(400);
    expect((unknown.body.issues as { pointer: string }[])[0]?.pointer).toBe("/kind");
  });
});
