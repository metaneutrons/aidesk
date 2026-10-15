import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ZodError } from "zod";
import { db, sqlClient } from "../src/server/db";
import { aiProfiles, audit, configChanges, connections, projects } from "../src/server/db/schema";
import { listAiProfiles, setAiProfile } from "../src/server/ai-profiles";
import {
  decideConfigChange,
  getConfig,
  listConfigChanges,
  putConfig,
} from "../src/server/configuration";
import { aiDefaults } from "../src/domain/ai";
import type { Action, Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const person = (name: string, kind: "human" | "agent", actions: Action[]): Principal => ({
  id: `${name}-${projectId}`,
  kind,
  active: true,
  owner: false,
  grants: [{ projectId, actions }],
});
const read: Action[] = ["project.read", "config.read"];
const write: Action[] = [...read, "config.write"];
const manager = person("manager", "human", [...write, "config.approve", "integration.manage"]);
const writer = person("writer", "human", write);
const agent = person("agent", "agent", write);
const reader = person("reader", "human", read);
const ids = { first: "", second: "", disabled: "", mail: "", foreign: "" };
async function connection(
  project: string,
  kind: string,
  direction: string,
  status = "ready",
): Promise<string> {
  const [row] = await db()
    .insert(connections)
    .values({ projectId: project, kind, direction, name: `${kind} ${direction}`, status })
    .returning({ id: connections.id });
  return row?.id ?? "";
}
const body = (overrides: Record<string, unknown> = {}) => ({
  expectedVersion: 0,
  connectionId: ids.first,
  model: "model-one",
  ...overrides,
});
const profile = (task = "reply.draft") =>
  listAiProfiles(manager, projectId).then((entries) =>
    entries.find((entry) => entry.task === task),
  );
async function setPolicy(policy: "review" | "direct") {
  const current = await getConfig(manager, projectId);
  if (current.config.approvalPolicy !== policy)
    await putConfig(manager, projectId, {
      config: { ...current.config, approvalPolicy: policy },
      expectedVersion: current.version,
    });
}
async function reset() {
  await db().delete(configChanges).where(eq(configChanges.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(aiProfiles).where(eq(aiProfiles.projectId, projectId));
  await setPolicy("review");
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Profiles", slug: `prof-${projectId}` },
      { id: otherProject, name: "Other", slug: `prof-${otherProject}` },
    ]);
  ids.first = await connection(projectId, "anthropic", "ai");
  ids.second = await connection(projectId, "openai", "ai");
  ids.disabled = await connection(projectId, "google", "ai", "disabled");
  ids.mail = await connection(projectId, "smtp", "outbound");
  ids.foreign = await connection(otherProject, "anthropic", "ai");
});
afterAll(async () => {
  await db().delete(configChanges).where(eq(configChanges.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await db().delete(projects).where(eq(projects.id, otherProject));
  await sqlClient().end();
});
beforeEach(reset);
const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ZodError);
  return (error as ZodError).issues.map((issue) => `${issue.path.join("/")}: ${issue.message}`);
};
describe("reading the profiles", () => {
  it("lists every task, with version 0 and the defaults where none was set", async () => {
    expect(await listAiProfiles(reader, projectId)).toEqual([
      {
        task: "reply.draft",
        version: 0,
        connectionId: null,
        model: null,
        enabled: false,
        ...aiDefaults,
      },
      {
        task: "note.draft",
        version: 0,
        connectionId: null,
        model: null,
        enabled: false,
        ...aiDefaults,
      },
      {
        task: "image.read",
        version: 0,
        connectionId: null,
        model: null,
        enabled: false,
        ...aiDefaults,
      },
      {
        task: "agent.respond",
        version: 0,
        connectionId: null,
        model: null,
        enabled: false,
        ...aiDefaults,
      },
    ]);
  });
  it("needs config.read and shows nothing of another project", async () => {
    await expect(listAiProfiles({ ...reader, grants: [] }, projectId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      listAiProfiles(
        { ...reader, grants: [{ projectId: otherProject, actions: read }] },
        projectId,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
describe("setting a profile that is off", () => {
  it("is applied for a person with config.write, raises the version and says what changed", async () => {
    const created = await setAiProfile(writer, projectId, "reply.draft", body());
    expect(created).toMatchObject({ outcome: "applied", target: "reply.draft", version: 1 });
    expect(created.diff.map((entry) => entry.pointer).sort()).toEqual(
      [
        "connectionId",
        "dailyTokenBudget",
        "enabled",
        "maxOutputTokens",
        "model",
        "timeoutSeconds",
      ].map((field) => `/aiProfiles/reply.draft/${field}`),
    );
    expect(await profile()).toMatchObject({
      version: 1,
      connectionId: ids.first,
      model: "model-one",
      enabled: false,
      ...aiDefaults,
    });
    // The same again changes nothing; a change raises the version.
    expect(
      await setAiProfile(writer, projectId, "reply.draft", body({ expectedVersion: 1 })),
    ).toMatchObject({
      outcome: "unchanged",
    });
    const changed = await setAiProfile(
      writer,
      projectId,
      "reply.draft",
      body({ expectedVersion: 1, model: "model-two", timeoutSeconds: 30, dailyTokenBudget: 5000 }),
    );
    expect(changed).toMatchObject({ outcome: "applied", version: 2 });
    expect(changed.diff.map((entry) => entry.pointer)).toEqual([
      "/aiProfiles/reply.draft/model",
      "/aiProfiles/reply.draft/timeoutSeconds",
      "/aiProfiles/reply.draft/dailyTokenBudget",
    ]);
    // The other task is untouched.
    expect(await profile("note.draft")).toMatchObject({ version: 0, connectionId: null });
  });
  it("refuses a stale version, also for the first write", async () => {
    await expect(
      setAiProfile(writer, projectId, "reply.draft", body({ expectedVersion: 3 })),
    ).rejects.toMatchObject({
      code: "stale_version",
    });
    await setAiProfile(writer, projectId, "reply.draft", body());
    await expect(setAiProfile(writer, projectId, "reply.draft", body())).rejects.toMatchObject({
      code: "stale_version",
    });
  });
  it("names the field that is wrong", async () => {
    expect(await refusal(setAiProfile(writer, projectId, "translate", body()))).toEqual([
      "task: One of reply.draft, note.draft, image.read, agent.respond",
    ]);
    expect(
      await refusal(setAiProfile(writer, projectId, "reply.draft", body({ model: "bad model!" }))),
    ).toEqual(["model: A model name has letters, digits and . _ : / -"]);
    for (const [field, value] of [
      ["timeoutSeconds", 0],
      ["timeoutSeconds", 301],
      ["maxOutputTokens", 16_001],
      ["dailyTokenBudget", 0],
    ] as const)
      expect(
        (
          await refusal(setAiProfile(writer, projectId, "reply.draft", body({ [field]: value })))
        )[0],
      ).toContain(field);
    expect(
      await refusal(setAiProfile(writer, projectId, "reply.draft", body({ extra: true }))),
    ).toHaveLength(1);
  });
  it("accepts only an enabled connection to a model provider of the project, and says which field", async () => {
    const wrong = [
      [ids.foreign, "Not a connection to a model provider of this project"],
      [ids.mail, "Not a connection to a model provider of this project"],
      [randomUUID(), "Not a connection to a model provider of this project"],
      [ids.disabled, "This connection is disabled"],
    ] as const;
    for (const [connectionId, message] of wrong)
      expect(
        await refusal(setAiProfile(writer, projectId, "reply.draft", body({ connectionId }))),
      ).toEqual([`connectionId: ${message}`]);
    expect(await profile()).toMatchObject({ version: 0 });
  });
  it("needs config.write, and config.read to see it at all", async () => {
    await expect(setAiProfile(reader, projectId, "reply.draft", body())).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      setAiProfile({ ...writer, grants: [] }, projectId, "reply.draft", body()),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("is proposed by an agent under the review policy, and applied by one under direct", async () => {
    const proposed = await setAiProfile(agent, projectId, "reply.draft", body());
    expect(proposed).toMatchObject({ outcome: "proposed" });
    expect(await profile()).toMatchObject({ version: 0 });
    await setPolicy("direct");
    expect(await setAiProfile(agent, projectId, "reply.draft", body())).toMatchObject({
      outcome: "applied",
      version: 1,
    });
  });
});
describe("switching a profile on", () => {
  it("is applied at once only by a person with config.approve", async () => {
    expect(
      await setAiProfile(manager, projectId, "reply.draft", body({ enabled: true })),
    ).toMatchObject({
      outcome: "applied",
      version: 1,
    });
    expect(await profile()).toMatchObject({ enabled: true });
  });
  it("is a proposal for a person without config.approve, under every policy", async () => {
    for (const policy of ["review", "direct"] as const) {
      await reset();
      await setPolicy(policy);
      const answer = await setAiProfile(writer, projectId, "reply.draft", body({ enabled: true }));
      expect(answer, policy).toMatchObject({ outcome: "proposed" });
      expect(await profile(), policy).toMatchObject({ version: 0, enabled: false });
    }
  });
  it("is a proposal for an agent, also under direct, and a person decides", async () => {
    await setPolicy("direct");
    const proposed = await setAiProfile(agent, projectId, "reply.draft", body({ enabled: true }));
    expect(proposed).toMatchObject({ outcome: "proposed" });
    expect(await profile()).toMatchObject({ enabled: false });
    // An agent cannot decide, a person without the right cannot, one with it can.
    await expect(
      decideConfigChange(agent, proposed.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      decideConfigChange(writer, proposed.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await decideConfigChange(manager, proposed.changeId ?? "", { decision: "approve" });
    expect(await profile()).toMatchObject({ enabled: true, version: 1, connectionId: ids.first });
  });
  it("is checked as a proposal says: a stale one is superseded and one for a connection that is gone is refused", async () => {
    const stale = await setAiProfile(agent, projectId, "reply.draft", body({ enabled: true }));
    await setAiProfile(writer, projectId, "reply.draft", body({ model: "newer" }));
    await expect(
      decideConfigChange(manager, stale.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({
      code: "stale_version",
    });
    expect(
      (await listConfigChanges(manager, projectId, "superseded")).map((entry) => entry.id),
    ).toContain(stale.changeId);
    expect(await profile()).toMatchObject({ enabled: false, model: "newer" });
    const lost = await connection(projectId, "anthropic", "ai");
    const proposal = await setAiProfile(
      agent,
      projectId,
      "reply.draft",
      body({ expectedVersion: 1, connectionId: lost, enabled: true }),
    );
    await db().update(connections).set({ status: "disabled" }).where(eq(connections.id, lost));
    expect(
      await refusal(decideConfigChange(manager, proposal.changeId ?? "", { decision: "approve" })),
    ).toEqual(["connectionId: This connection is disabled"]);
    expect(await profile()).toMatchObject({ enabled: false });
  });
  it("is reported by a check that writes nothing, as applied for a person who may approve and as a proposal for others", async () => {
    expect(
      await setAiProfile(manager, projectId, "reply.draft", body({ enabled: true }), {
        validate: true,
      }),
    ).toMatchObject({ outcome: "applied", validated: true, changeId: null });
    expect(
      await setAiProfile(writer, projectId, "reply.draft", body({ enabled: true }), {
        validate: true,
      }),
    ).toMatchObject({ outcome: "proposed", validated: true, changeId: null });
    expect(await profile()).toMatchObject({ version: 0 });
    expect(
      await db().select().from(configChanges).where(eq(configChanges.projectId, projectId)),
    ).toHaveLength(0);
  });
});
describe("a profile that is on", () => {
  beforeEach(async () => {
    await setAiProfile(manager, projectId, "reply.draft", body({ enabled: true }));
  });
  it("cannot be pointed at another provider except by a person who may approve", async () => {
    await setPolicy("direct");
    const change = body({ expectedVersion: 1, connectionId: ids.second, enabled: true });
    expect(await setAiProfile(agent, projectId, "reply.draft", change)).toMatchObject({
      outcome: "proposed",
    });
    expect(await setAiProfile(writer, projectId, "reply.draft", change)).toMatchObject({
      outcome: "proposed",
    });
    expect(await profile()).toMatchObject({ connectionId: ids.first });
    expect(await setAiProfile(manager, projectId, "reply.draft", change)).toMatchObject({
      outcome: "applied",
      version: 2,
    });
    expect(await profile()).toMatchObject({ connectionId: ids.second, enabled: true });
  });
  it("follows the approval policy for the model and the limits, which send nothing elsewhere", async () => {
    const tuned = body({
      expectedVersion: 1,
      enabled: true,
      model: "model-two",
      dailyTokenBudget: 1000,
    });
    expect(await setAiProfile(agent, projectId, "reply.draft", tuned)).toMatchObject({
      outcome: "proposed",
    });
    await setPolicy("direct");
    expect(await setAiProfile(agent, projectId, "reply.draft", tuned)).toMatchObject({
      outcome: "applied",
      version: 2,
    });
    expect(await profile()).toMatchObject({
      model: "model-two",
      dailyTokenBudget: 1000,
      enabled: true,
    });
  });
  it("can be switched off by anyone who may write, and then needs approval to be switched on again", async () => {
    expect(
      await setAiProfile(
        writer,
        projectId,
        "reply.draft",
        body({ expectedVersion: 1, enabled: false }),
      ),
    ).toMatchObject({ outcome: "applied", version: 2 });
    expect(await profile()).toMatchObject({ enabled: false });
    expect(
      await setAiProfile(
        writer,
        projectId,
        "reply.draft",
        body({ expectedVersion: 2, enabled: true }),
      ),
    ).toMatchObject({ outcome: "proposed" });
    expect(
      await setAiProfile(
        agent,
        projectId,
        "reply.draft",
        body({ expectedVersion: 1, enabled: false }),
      ).catch((e: unknown) => e),
    ).toMatchObject({ code: "stale_version" });
  });
});
describe("records of a change", () => {
  it("keeps each change in the audit, and a repeated request has the effect of one", async () => {
    const key = randomUUID();
    const first = await setAiProfile(
      writer,
      projectId,
      "reply.draft",
      body({ idempotencyKey: key }),
    );
    const again = await setAiProfile(
      writer,
      projectId,
      "reply.draft",
      body({ idempotencyKey: key }),
    );
    expect(again).toMatchObject({ outcome: "applied", changeId: first.changeId, version: 1 });
    await expect(
      setAiProfile(manager, projectId, "reply.draft", body({ idempotencyKey: key })),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const entries = await db().select().from(audit).where(eq(audit.projectId, projectId));
    const sets = entries.filter((entry) => entry.action === "ai_profile.set");
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ actorId: writer.id, targetId: "reply.draft" });
    expect(sets[0]?.detail).toMatchObject({ enabled: false });
    const proposed = await setAiProfile(
      agent,
      projectId,
      "reply.draft",
      body({ expectedVersion: 1, model: "x", enabled: true }),
    );
    const kept = await listConfigChanges(manager, projectId, "pending");
    expect(kept.find((entry) => entry.id === proposed.changeId)).toMatchObject({
      kind: "ai_profile.set",
      target: "reply.draft",
      proposedBy: agent.id,
    });
  });
});
