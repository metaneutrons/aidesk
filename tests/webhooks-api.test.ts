import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
}));
import { db, sqlClient } from "../src/server/db";
import { audit, jobs, projects } from "../src/server/db/schema";
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
  name: "Receiver",
  url: "https://hooks.example.test/in",
  events: ["ticket.created", "change.proposed"],
  secret: "a-secret-of-some-length",
};
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values({ id: projectId, name: "Webhooks API", slug: `whapi-${projectId}` });
});
afterAll(async () => {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db()
    .delete(audit)
    .where(inArray(audit.projectId, [projectId]));
  await db().delete(projects).where(eq(projects.id, projectId));
  await sqlClient().end();
});
describe("webhooks over REST", () => {
  it("answers with the documented statuses and never shows the secret", async () => {
    const base = `/projects/${projectId}/webhooks`;
    expect((await call(manager, "POST", `${base}?validate=true`, definition)).status).toBe(200);
    const created = await call(manager, "POST", base, definition);
    expect(created).toMatchObject({ status: 201, body: { outcome: "applied", version: 1 } });
    const id = created.body.target as string;
    const listed = await call(manager, "GET", base);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(definition.secret);
    expect((listed.body as unknown as { secretSet: boolean }[])[0]?.secretSet).toBe(true);
    expect(
      (await call(manager, "PUT", `${base}/${id}`, { expectedVersion: 1, name: "Renamed" })).status,
    ).toBe(200);
    const proposed = await call(agent, "PUT", `${base}/${id}`, {
      expectedVersion: 2,
      name: "By agent",
    });
    expect(proposed).toMatchObject({ status: 202, body: { outcome: "proposed" } });
    expect(
      (await call(manager, "PUT", `${base}/${id}`, { expectedVersion: 1, name: "Late" })).body,
    ).toEqual({ error: "stale_version" });
    const ping = await call(manager, "POST", `${base}/${id}/ping`);
    expect(ping.status).toBe(202);
    expect(ping.body.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call(manager, "GET", `${base}/${id}/deliveries`)).body).toEqual([]);
    expect(
      (await call(manager, "POST", `${base}/${id}/disable`, { expectedVersion: 2 })).body,
    ).toMatchObject({ outcome: "applied", version: 3 });
    expect((await call(manager, "POST", `${base}/${id}/ping`)).status).toBe(409);
  });
  it("names the offending field", async () => {
    const base = `/projects/${projectId}/webhooks`;
    const bad = await call(manager, "POST", base, {
      ...definition,
      url: "http://hooks.example.test/in",
      events: [],
    });
    expect(bad.status).toBe(400);
    expect((bad.body.issues as { pointer: string }[]).map((issue) => issue.pointer).sort()).toEqual(
      ["/events"],
    );
    const http = await call(manager, "POST", base, {
      ...definition,
      url: "http://hooks.example.test/in",
    });
    expect(http.status).toBe(400);
    expect((http.body.issues as { pointer: string; message: string }[])[0]).toMatchObject({
      pointer: "/url",
      message: "HTTPS is required",
    });
  });
});
