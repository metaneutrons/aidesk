import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ZodError } from "zod";
import { db, sqlClient } from "../src/server/db";
import { audit, configChanges, projects } from "../src/server/db/schema";
import {
  decideConfigChange,
  getConfig,
  listConfigChanges,
  putConfig,
} from "../src/server/configuration";
import { issueAgentToken, setProjectSettings } from "../src/server/operations";
import type { Action, Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const person = (name: string, held: Action[], project = projectId): Principal => ({
  id: `${name}-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId: project, actions: held }],
});
const manager = person("manager", [
  "project.read",
  "project.manage",
  "agent.manage",
  "config.read",
  "config.write",
  "config.approve",
]);
const writer = person("writer", ["project.read", "config.read", "config.write"]);
const reader = person("reader", ["project.read", "config.read"]);
const plain = person("plain", ["project.read", "ticket.read"]);
const elsewhere = person(
  "elsewhere",
  ["config.read", "config.write", "config.approve"],
  otherProject,
);
const agent: Principal = { ...writer, id: `agent-${projectId}`, kind: "agent" };
const approvingAgent: Principal = { ...manager, id: `rogue-${projectId}`, kind: "agent" };
async function reset() {
  await db().delete(configChanges).where(eq(configChanges.projectId, projectId));
  await db()
    .update(projects)
    .set({
      name: "Config",
      color: "#5167ed",
      defaultLanguage: "en",
      settings: { internalNote: "keep-me", emailDesignVersion: 3 },
      configVersion: 1,
    })
    .where(eq(projects.id, projectId));
}
const current = async () => (await getConfig(manager, projectId)).config;
const edit = async (change: Record<string, unknown>) => ({
  config: { ...(await current()), ...change },
  expectedVersion: (await getConfig(manager, projectId)).version,
});
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Config", slug: `config-${projectId}` },
      { id: otherProject, name: "Other", slug: `config-${otherProject}` },
    ]);
});
afterAll(async () => {
  const ids = [projectId, otherProject];
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("reading the configuration", () => {
  it("returns the document and its version to whoever holds config.read", async () => {
    await reset();
    expect(await getConfig(reader, projectId)).toEqual({
      slug: `config-${projectId}`,
      version: 1,
      config: {
        name: "Config",
        color: "#5167ed",
        defaultLanguage: "en",
        acknowledgements: false,
        portalLinks: false,
        approvalPolicy: "review",
        outboundConnectionId: null,
        pauseOutgoing: false,
        overdueHours: 24,
      },
    });
  });
  it("exposes only the document, never the settings that hold connections or other internals", async () => {
    await reset();
    const text = JSON.stringify(await getConfig(reader, projectId));
    expect(text).not.toContain("keep-me");
    expect(text).not.toContain("internalNote");
    expect(text).not.toContain("emailDesignVersion");
    const changed = await putConfig(writer, projectId, await edit({ name: "Visible" }));
    const stored = JSON.stringify(await listConfigChanges(reader, projectId));
    expect(stored).not.toContain("keep-me");
    expect(changed.diff.every((entry) => entry.pointer === "/name")).toBe(true);
  });
  it("answers not_found without config.read, and for another project's grant", async () => {
    await expect(getConfig(plain, projectId)).rejects.toMatchObject({ code: "not_found" });
    await expect(getConfig(elsewhere, projectId)).rejects.toMatchObject({ code: "not_found" });
    await expect(listConfigChanges(plain, projectId)).rejects.toMatchObject({ code: "not_found" });
  });
});
describe("writing as a person", () => {
  it("applies at once, raises the version, keeps other settings and audits the diff", async () => {
    await reset();
    const result = await putConfig(
      writer,
      projectId,
      await edit({ name: "Renamed", portalLinks: true }),
    );
    expect(result).toMatchObject({ outcome: "applied", version: 2, validated: false });
    expect(result.diff).toEqual([
      { pointer: "/name", from: "Config", to: "Renamed" },
      { pointer: "/portalLinks", from: false, to: true },
    ]);
    const [row] = await db().select().from(projects).where(eq(projects.id, projectId));
    expect(row).toMatchObject({ name: "Renamed", configVersion: 2 });
    expect(row?.settings).toMatchObject({
      portalLinks: true,
      internalNote: "keep-me",
      emailDesignVersion: 3,
    });
    const [entry] = await db()
      .select()
      .from(audit)
      .where(eq(audit.targetId, result.changeId ?? ""));
    expect(entry).toMatchObject({ action: "config.apply", actorId: writer.id });
  });
  it("does nothing when nothing differs", async () => {
    await reset();
    expect(await putConfig(writer, projectId, await edit({}))).toMatchObject({
      outcome: "unchanged",
      version: 1,
      changeId: null,
      diff: [],
    });
    expect(await listConfigChanges(reader, projectId)).toEqual([]);
  });
  it("refuses a stale version, also under concurrency", async () => {
    await reset();
    const stale = await edit({ color: "#112233" });
    await putConfig(writer, projectId, await edit({ name: "First" }));
    await expect(putConfig(writer, projectId, stale)).rejects.toMatchObject({
      code: "stale_version",
    });
    const same = await edit({});
    const outcomes = await Promise.allSettled([
      putConfig(writer, projectId, { ...same, config: { ...same.config, name: "A" } }),
      putConfig(writer, projectId, { ...same, config: { ...same.config, name: "B" } }),
    ]);
    expect(outcomes.map((entry) => entry.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await getConfig(reader, projectId)).version).toBe(3);
  });
  it("needs config.write and refuses a document that is not valid", async () => {
    await reset();
    await expect(putConfig(reader, projectId, await edit({ name: "No" }))).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(putConfig(plain, projectId, await edit({}))).rejects.toMatchObject({
      code: "not_found",
    });
    for (const bad of [{ color: "red" }, { name: "" }, { approvalPolicy: "maybe" }, { unknown: 1 }])
      await expect(putConfig(writer, projectId, await edit(bad))).rejects.toBeInstanceOf(ZodError);
    await expect(
      putConfig(writer, projectId, { config: await current(), expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(ZodError);
    expect((await getConfig(reader, projectId)).version).toBe(1);
  });
});
describe("validating without writing", () => {
  it("returns the diff and what would happen and changes nothing", async () => {
    await reset();
    const body = await edit({ acknowledgements: true });
    expect(await putConfig(writer, projectId, body, { validate: true })).toMatchObject({
      outcome: "applied",
      validated: true,
      changeId: null,
      diff: [{ pointer: "/acknowledgements", from: false, to: true }],
    });
    expect(await putConfig(agent, projectId, body, { validate: true })).toMatchObject({
      outcome: "proposed",
      validated: true,
    });
    expect((await getConfig(reader, projectId)).version).toBe(1);
    expect((await getConfig(reader, projectId)).config.acknowledgements).toBe(false);
    expect(await listConfigChanges(reader, projectId)).toEqual([]);
    await expect(
      putConfig(writer, projectId, { ...body, expectedVersion: 9 }, { validate: true }),
    ).rejects.toMatchObject({ code: "stale_version" });
  });
});
describe("an agent under the review policy", () => {
  it("proposes, and nothing changes until a person activates it", async () => {
    await reset();
    const proposed = await putConfig(agent, projectId, await edit({ acknowledgements: true }));
    expect(proposed).toMatchObject({ outcome: "proposed", version: 1, validated: false });
    expect((await current()).acknowledgements).toBe(false);
    const [pending] = await listConfigChanges(reader, projectId, "pending");
    expect(pending).toMatchObject({
      id: proposed.changeId,
      status: "pending",
      proposerKind: "agent",
      baseVersion: 1,
    });
    expect(
      await decideConfigChange(manager, proposed.changeId ?? "", { decision: "approve" }),
    ).toEqual({
      id: proposed.changeId,
      status: "applied",
      version: 2,
    });
    expect((await current()).acknowledgements).toBe(true);
    const [done] = await listConfigChanges(reader, projectId, "applied");
    expect(done).toMatchObject({ decidedBy: manager.id, appliedVersion: 2 });
    // Deciding twice has no further effect.
    await expect(
      decideConfigChange(manager, proposed.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await getConfig(reader, projectId)).version).toBe(2);
  });
  it("never applies a rejected proposal", async () => {
    await reset();
    const proposed = await putConfig(agent, projectId, await edit({ name: "Rejected name" }));
    expect(
      await decideConfigChange(manager, proposed.changeId ?? "", {
        decision: "reject",
        reason: "No",
      }),
    ).toMatchObject({ status: "rejected", version: 1 });
    expect((await current()).name).toBe("Config");
    await expect(
      decideConfigChange(manager, proposed.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await current()).name).toBe("Config");
    const [entry] = await listConfigChanges(reader, projectId, "rejected");
    expect(entry).toMatchObject({ reason: "No", decidedBy: manager.id });
  });
  it("lapses when the configuration changed meanwhile, however it changed", async () => {
    await reset();
    const first = await putConfig(agent, projectId, await edit({ name: "From agent" }));
    const second = await putConfig(agent, projectId, await edit({ color: "#abcdef" }));
    await putConfig(writer, projectId, await edit({ portalLinks: true }));
    expect(
      (await listConfigChanges(reader, projectId, "superseded")).map((entry) => entry.id).sort(),
    ).toEqual([first.changeId, second.changeId].sort());
    await expect(
      decideConfigChange(manager, first.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "conflict" });
    // The settings route bumps the version as well.
    const third = await putConfig(agent, projectId, await edit({ name: "Third" }));
    await setProjectSettings(manager, projectId, { acknowledgements: true });
    expect(
      (await listConfigChanges(reader, projectId, "superseded")).map((entry) => entry.id),
    ).toContain(third.changeId);
    // A proposal that is still pending on an older version is refused at activation.
    const fourth = await putConfig(agent, projectId, await edit({ name: "Fourth" }));
    await db()
      .update(projects)
      .set({ configVersion: sql`${projects.configVersion} + 1` })
      .where(eq(projects.id, projectId));
    await expect(
      decideConfigChange(manager, fourth.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "stale_version" });
    expect(
      (await listConfigChanges(reader, projectId, "superseded")).map((entry) => entry.id),
    ).toContain(fourth.changeId);
    expect((await current()).name).not.toBe("Fourth");
  });
  it("cannot activate its own proposal, and people need config.approve", async () => {
    await reset();
    const proposed = await putConfig(agent, projectId, await edit({ name: "Mine" }));
    for (const caller of [agent, approvingAgent])
      await expect(
        decideConfigChange(caller, proposed.changeId ?? "", { decision: "approve" }),
      ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      decideConfigChange(writer, proposed.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      decideConfigChange(plain, proposed.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      decideConfigChange(elsewhere, proposed.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await current()).name).toBe("Config");
  });
});
describe("the approval policy", () => {
  it("is changed only by a person with config.approve, and audited", async () => {
    await reset();
    await expect(
      putConfig(writer, projectId, await edit({ approvalPolicy: "direct" })),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      putConfig(agent, projectId, await edit({ approvalPolicy: "direct" })),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      putConfig(approvingAgent, projectId, await edit({ approvalPolicy: "direct" })),
    ).rejects.toMatchObject({ code: "forbidden" });
    const switched = await putConfig(manager, projectId, await edit({ approvalPolicy: "direct" }));
    expect(switched).toMatchObject({ outcome: "applied" });
    const [entry] = await db()
      .select()
      .from(audit)
      .where(eq(audit.targetId, switched.changeId ?? ""));
    expect(entry).toMatchObject({ action: "config.apply", actorId: manager.id });
  });
  it("lets an agent apply directly once the policy is direct, and still not change the policy", async () => {
    await reset();
    await putConfig(manager, projectId, await edit({ approvalPolicy: "direct" }));
    const applied = await putConfig(agent, projectId, await edit({ color: "#445566" }));
    expect(applied).toMatchObject({ outcome: "applied" });
    expect((await current()).color).toBe("#445566");
    await expect(
      putConfig(agent, projectId, await edit({ approvalPolicy: "review" })),
    ).rejects.toMatchObject({ code: "forbidden" });
    await putConfig(manager, projectId, await edit({ approvalPolicy: "review" }));
    expect(await putConfig(agent, projectId, await edit({ color: "#665544" }))).toMatchObject({
      outcome: "proposed",
    });
  });
});
describe("repeating a request", () => {
  it("has the effect of one when the key is the same", async () => {
    await reset();
    const body = { ...(await edit({ name: "Once" })), idempotencyKey: randomUUID() };
    const first = await putConfig(writer, projectId, body);
    const again = await putConfig(writer, projectId, body);
    expect(again).toEqual(first);
    expect((await getConfig(reader, projectId)).version).toBe(2);
    expect(await listConfigChanges(reader, projectId)).toHaveLength(1);
    await expect(
      putConfig(writer, projectId, { ...body, config: { ...body.config, name: "Twice" } }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(putConfig(manager, projectId, body)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });
  it("returns the same proposal for a repeated agent request", async () => {
    await reset();
    const body = { ...(await edit({ name: "Proposed once" })), idempotencyKey: randomUUID() };
    const first = await putConfig(agent, projectId, body);
    expect(await putConfig(agent, projectId, body)).toEqual(first);
    expect(await listConfigChanges(reader, projectId)).toHaveLength(1);
  });
});
describe("agent tokens", () => {
  it("cannot be issued with config.approve, but can with config.write", async () => {
    await expect(
      issueAgentToken(manager, projectId, { name: "Bad", actions: ["config.approve"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await issueAgentToken(manager, projectId, {
        name: "Configurator",
        actions: ["project.read", "config.read", "config.write"],
      }),
    ).toMatchObject({ actions: ["project.read", "config.read", "config.write"] });
  });
});

describe("the overdue limit", () => {
  it("is part of the document within 1 to 720 hours and defaults to 24", async () => {
    await reset();
    expect((await current()).overdueHours).toBe(24);
    for (const bad of [0, 721, 1.5, "12"])
      await expect(
        putConfig(writer, projectId, await edit({ overdueHours: bad })),
      ).rejects.toBeInstanceOf(ZodError);
    expect(await putConfig(writer, projectId, await edit({ overdueHours: 12 }))).toMatchObject({
      outcome: "applied",
      diff: [{ pointer: "/overdueHours", from: 24, to: 12 }],
    });
    expect((await current()).overdueHours).toBe(12);
    await db()
      .update(projects)
      .set({ settings: { overdueHours: "garbage" } })
      .where(eq(projects.id, projectId));
    expect((await current()).overdueHours).toBe(24);
  });
});
describe("projects and changes that do not exist", () => {
  const ghost = randomUUID();
  const ghostManager: Principal = {
    ...manager,
    grants: [{ projectId: ghost, actions: [...manager.grants[0]!.actions] }],
  };
  it("answers not_found", async () => {
    await expect(getConfig(ghostManager, ghost)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      putConfig(ghostManager, ghost, { config: await current(), expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      decideConfigChange(manager, randomUUID(), { decision: "approve" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(listConfigChanges(manager, projectId, "bogus")).rejects.toBeInstanceOf(ZodError);
  });
  it("reads a German project with an outgoing connection from its settings", async () => {
    await reset();
    const connection = randomUUID();
    await db()
      .update(projects)
      .set({
        defaultLanguage: "de",
        settings: { outboundConnectionId: connection, pauseOutgoing: true },
      })
      .where(eq(projects.id, projectId));
    expect((await getConfig(reader, projectId)).config).toMatchObject({
      defaultLanguage: "de",
      outboundConnectionId: connection,
      pauseOutgoing: true,
    });
  });
});
