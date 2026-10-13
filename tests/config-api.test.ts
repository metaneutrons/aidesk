import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  "config.read",
  "config.write",
  "config.approve",
]);
const agent = person("agent", "agent", ["project.read", "config.read", "config.write"]);
const origin = "http://localhost:3000";
async function call(principal: Principal, method: string, path: string, body?: unknown) {
  const response = await handle(
    new Request(`http://localhost:3000/api/v1${path}`, {
      method,
      headers: { origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    principal,
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values({ id: projectId, name: "Config API", slug: `cfg-${projectId}` });
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
describe("configuration over REST", () => {
  it("reads, validates, applies, proposes and decides with the documented statuses", async () => {
    const read = await call(manager, "GET", `/projects/${projectId}/config`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      version: 1,
      config: { name: "Config API", approvalPolicy: "review" },
    });
    const change = (patch: object, version = 1) => ({
      config: { ...read.body.config, ...patch },
      expectedVersion: version,
    });
    // Validate: nothing is written.
    const checked = await call(
      manager,
      "PUT",
      `/projects/${projectId}/config?validate=true`,
      change({ portalLinks: true }),
    );
    expect(checked).toMatchObject({ status: 200, body: { outcome: "applied", validated: true } });
    expect((await call(manager, "GET", `/projects/${projectId}/config`)).body.version).toBe(1);
    // An agent under the review policy gets 202 and a proposal.
    const proposed = await call(
      agent,
      "PUT",
      `/projects/${projectId}/config`,
      change({ aiMode: "autonomous" }),
    );
    expect(proposed.status).toBe(202);
    expect(proposed.body).toMatchObject({ outcome: "proposed", validated: false });
    expect(
      (
        await call(
          agent,
          "PUT",
          `/projects/${projectId}/config?validate=true`,
          change({ aiMode: "off", name: "X" }),
        )
      ).status,
    ).toBe(200);
    const pending = await call(
      agent,
      "GET",
      `/projects/${projectId}/config/changes?status=pending`,
    );
    expect(pending.body).toHaveLength(1);
    // The agent cannot decide; a person can.
    expect(
      (
        await call(agent, "POST", `/config/changes/${String(proposed.body.changeId)}/decision`, {
          decision: "approve",
        })
      ).status,
    ).toBe(403);
    const decided = await call(
      manager,
      "POST",
      `/config/changes/${String(proposed.body.changeId)}/decision`,
      { decision: "approve" },
    );
    expect(decided).toMatchObject({ status: 200, body: { status: "applied", version: 2 } });
    // A person applies directly with 200; a stale version is a conflict.
    const applied = await call(
      manager,
      "PUT",
      `/projects/${projectId}/config`,
      change({ color: "#010203" }, 2),
    );
    expect(applied).toMatchObject({ status: 200, body: { outcome: "applied", version: 3 } });
    expect(
      (await call(manager, "PUT", `/projects/${projectId}/config`, change({ color: "#030201" }, 2)))
        .body,
    ).toEqual({ error: "stale_version" });
  });
  it("names the offending field of an invalid request", async () => {
    const bad = await call(manager, "PUT", `/projects/${projectId}/config`, {
      config: { name: "x", color: "red" },
      expectedVersion: 1,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_input");
    const pointers = (bad.body.issues as { pointer: string }[]).map((issue) => issue.pointer);
    expect(pointers).toContain("/config/color");
    expect(pointers).toContain("/config/aiMode");
  });
  it("refuses a change that does not come from the application's own origin", async () => {
    const response = await handle(
      new Request(`http://localhost:3000/api/v1/projects/${projectId}/config`, {
        method: "PUT",
        headers: { origin: "https://evil.example" },
        body: "{}",
      }),
      manager,
    );
    expect(response.status).toBe(403);
  });
});
describe("texts over REST", () => {
  it("lists, sets, proposes and names the offending field", async () => {
    const base = `/projects/${projectId}/texts`;
    const listed = await call(manager, "GET", base);
    expect(listed.status).toBe(200);
    expect(
      (listed.body as unknown as { key: string }[]).find(
        (entry) => entry.key === "acknowledgement",
      ),
    ).toMatchObject({
      required: ["number"],
      languages: { de: { own: null, version: 0 } },
    });
    const set = await call(manager, "PUT", `${base}/acknowledgement/de`, {
      text: "Hallo #{number}",
      expectedVersion: 0,
    });
    expect(set).toMatchObject({ status: 200, body: { outcome: "applied", version: 1 } });
    const proposed = await call(agent, "PUT", `${base}/acknowledgement/de`, {
      text: "Agent #{number}",
      expectedVersion: 1,
    });
    expect(proposed).toMatchObject({ status: 202, body: { outcome: "proposed" } });
    expect(
      (
        await call(agent, "PUT", `${base}/acknowledgement/de?validate=true`, {
          text: "Agent #{number}",
          expectedVersion: 1,
        })
      ).status,
    ).toBe(200);
    const versions = await call(manager, "GET", `${base}/acknowledgement/de/versions`);
    expect((versions.body as unknown as { version: number }[]).map((row) => row.version)).toEqual([
      1,
    ]);
    const bad = await call(manager, "PUT", `${base}/acknowledgement/de`, {
      text: "no number",
      expectedVersion: 1,
    });
    expect(bad.status).toBe(400);
    expect((bad.body.issues as { pointer: string }[]).map((issue) => issue.pointer)).toEqual([
      "/text",
    ]);
    expect(
      (await call(manager, "PUT", `${base}/acknowledgement/fr`, { text: "x", expectedVersion: 0 }))
        .body.issues[0].pointer,
    ).toBe("/language");
    expect(
      (
        await call(manager, "PUT", `${base}/acknowledgement/de`, {
          text: "Stale #{number}",
          expectedVersion: 0,
        })
      ).body,
    ).toEqual({ error: "stale_version" });
  });
});
