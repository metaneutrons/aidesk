import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "../src/server/db";
import { agents, audit, projects, user } from "../src/server/db/schema";
import {
  exportProjectAudit,
  exportWorkspaceAudit,
  listProjectAudit,
  listWorkspaceAudit,
} from "../src/server/audit-log";
import { getWorkspaceControls, setWorkspaceControls } from "../src/server/agent-controls";
import { createWebhook } from "../src/server/webhooks";
import { redactDetail } from "../src/domain/audit";
import { DomainError } from "../src/server/errors";
import type { Action, Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectA = randomUUID();
const projectB = randomUUID();
const person = (
  name: string,
  kind: "human" | "agent",
  project: string,
  held: Action[],
  owner = false,
): Principal => ({
  id: `${name}-${run}`,
  kind,
  active: true,
  owner,
  grants: [{ projectId: project, actions: held }],
});
const reader = person("reader", "human", projectA, ["project.read", "audit.read"]);
const tokenReader = person("token", "agent", projectA, ["project.read", "audit.read"]);
const readerOfB = person("readerb", "human", projectB, ["project.read", "audit.read"]);
const noRight = person("noright", "human", projectA, ["project.read", "ticket.read"]);
const owner = person("owner", "human", projectA, ["project.read"], true);
const agentId = randomUUID();
const userId = `auditor-${run}`;
async function put(
  project: string | null,
  actor: string,
  action: string,
  extra: { target?: string; detail?: Record<string, unknown>; at?: Date } = {},
) {
  await db()
    .insert(audit)
    .values({
      projectId: project,
      actorId: actor,
      action,
      targetId: extra.target ?? null,
      detail: extra.detail ?? {},
      ...(extra.at ? { createdAt: extra.at } : {}),
    });
}
const outcome = async (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof DomainError ? error.code : "other"),
  );
async function wipe() {
  await db()
    .delete(audit)
    .where(
      or(
        inArray(audit.projectId, [projectA, projectB]),
        like(audit.actorId, `%-${run}`),
        like(audit.actorId, `portal:${run}%`),
      ),
    );
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectA, name: "Audit A", slug: `audit-a-${run}` },
      { id: projectB, name: "Audit B", slug: `audit-b-${run}` },
    ]);
  await db()
    .insert(user)
    .values({ id: userId, name: "Ada Auditor", email: `${userId}@example.test` });
  await db()
    .insert(agents)
    .values({
      id: agentId,
      name: "Triage agent",
      projectId: projectA,
      actions: ["ticket.read"],
      tokenHash: `hash-${run}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await wipe();
  await db().delete(agents).where(eq(agents.id, agentId));
  await db().delete(user).where(eq(user.id, userId));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectA, projectB]));
});
describe("who may read the audit", () => {
  it("shows a project's entries to a reader and nothing of another project", async () => {
    await wipe();
    await put(projectA, userId, "ticket.status", { target: "t-a" });
    await put(projectB, userId, "ticket.status", { target: "t-b" });
    const a = await listProjectAudit(reader, projectA, {});
    expect(a.entries.map((entry) => entry.targetId)).toEqual(["t-a"]);
    expect(await outcome(listProjectAudit(readerOfB, projectA, {}))).toBe("not_found");
    expect(
      (await listProjectAudit(readerOfB, projectB, {})).entries.map((e) => e.targetId),
    ).toEqual(["t-b"]);
  });
  it("refuses a person without the right, an inactive one and an unknown project as not found", async () => {
    expect(await outcome(listProjectAudit(noRight, projectA, {}))).toBe("not_found");
    expect(await outcome(listProjectAudit({ ...reader, active: false }, projectA, {}))).toBe(
      "not_found",
    );
    expect(await outcome(listProjectAudit(reader, randomUUID(), {}))).toBe("not_found");
    expect(await outcome(exportProjectAudit(noRight, projectA, {}))).toBe("not_found");
  });
  it("lets a token with the right read, like a person", async () => {
    const page = await listProjectAudit(tokenReader, projectA, {});
    expect(page.entries.length).toBeGreaterThan(0);
  });
  it("keeps the entries without a project to the owner", async () => {
    await put(null, `owner-${run}`, "owner.test_entry");
    const mine = await listWorkspaceAudit(owner, { actor: `owner-${run}` });
    expect(mine.entries.map((entry) => entry.action)).toEqual(["owner.test_entry"]);
    expect(await outcome(listWorkspaceAudit(reader, {}))).toBe("not_found");
    expect(await outcome(listWorkspaceAudit({ ...owner, kind: "agent" }, {}))).toBe("not_found");
    expect(await outcome(exportWorkspaceAudit(reader, {}))).toBe("not_found");
    // A project reader never sees the entries of the workspace, and the owner's list holds no project entry.
    expect(
      (await listProjectAudit(reader, projectA, {})).entries.map((e) => e.action),
    ).not.toContain("owner.test_entry");
    expect(mine.entries.every((entry) => entry.actorId === `owner-${run}`)).toBe(true);
    const all = await listWorkspaceAudit(owner, { limit: 200 });
    expect(all.entries.map((entry) => entry.action)).not.toContain("ticket.status");
  });
});
describe("filters", () => {
  it("filters by actor, action, a family of actions, target and time", async () => {
    await wipe();
    await put(projectA, userId, "ticket.status", {
      target: "t1",
      at: new Date("2026-03-01T10:00:00Z"),
    });
    await put(projectA, userId, "ticket.assign", {
      target: "t2",
      at: new Date("2026-03-02T10:00:00Z"),
    });
    await put(projectA, `other-${run}`, "webhook.create", {
      target: "w1",
      at: new Date("2026-03-03T10:00:00Z"),
    });
    await put(projectA, userId, "my_x.one", { at: new Date("2026-03-04T10:00:00Z") });
    await put(projectA, userId, "myyx.two", { at: new Date("2026-03-05T10:00:00Z") });
    const actions = async (filter: Record<string, string>) =>
      (await listProjectAudit(reader, projectA, filter)).entries.map((entry) => entry.action);
    expect(await actions({ actor: `other-${run}` })).toEqual(["webhook.create"]);
    expect(await actions({ action: "ticket.assign" })).toEqual(["ticket.assign"]);
    expect((await actions({ action: "ticket." })).sort()).toEqual([
      "ticket.assign",
      "ticket.status",
    ]);
    expect(await actions({ target: "t1" })).toEqual(["ticket.status"]);
    expect(
      (await actions({ from: "2026-03-02T00:00:00Z", to: "2026-03-04T00:00:00Z" })).sort(),
    ).toEqual(["ticket.assign", "webhook.create"]);
    // The underscore of a family is a letter, not a wildcard: my_x. does not find myyx.
    expect(await actions({ action: "my_x." })).toEqual(["my_x.one"]);
    // The percent sign cannot get in at all.
    expect(await outcome(listProjectAudit(reader, projectA, { action: "ticket%" }))).toBe("other");
    expect(await outcome(listProjectAudit(reader, projectA, { limit: "0" }))).toBe("other");
    expect(await outcome(listProjectAudit(reader, projectA, { from: "yesterday" }))).toBe("other");
  });
  it("names an operator and an agent, and marks a customer and an unknown actor", async () => {
    await wipe();
    await put(projectA, userId, "a.one");
    await put(projectA, agentId, "a.two");
    await put(projectA, `portal:${run}-p`, "a.three");
    await put(projectA, `ghost-${run}`, "a.four");
    const byAction = new Map(
      (await listProjectAudit(reader, projectA, {})).entries.map((entry) => [entry.action, entry]),
    );
    expect(byAction.get("a.one")).toMatchObject({ actorName: "Ada Auditor", actorKind: "user" });
    expect(byAction.get("a.two")).toMatchObject({ actorName: "Triage agent", actorKind: "agent" });
    expect(byAction.get("a.three")).toMatchObject({ actorName: null, actorKind: "customer" });
    expect(byAction.get("a.four")).toMatchObject({ actorName: null, actorKind: "unknown" });
  });
});
describe("paging", () => {
  it("returns every entry once, newest first, also when many share a time to the microsecond", async () => {
    await wipe();
    // Ten entries with the same time, six that differ by a microsecond each, and two older ones.
    for (let n = 0; n < 10; n++)
      await db().execute(sql`insert into audit (project_id, actor_id, action, created_at)
        values (${projectA}, ${userId}, ${`same.${String(n)}`}, '2026-04-01 12:00:00.500000+00')`);
    for (let n = 1; n <= 6; n++)
      await db().execute(sql`insert into audit (project_id, actor_id, action, created_at)
        values (${projectA}, ${userId}, ${`micro.${String(n)}`}, ${`2026-04-02 12:00:00.00000${String(n)}+00`}::timestamptz)`);
    await put(projectA, userId, "old.one", { at: new Date("2026-03-31T00:00:00Z") });
    await put(projectA, userId, "old.two", { at: new Date("2026-03-30T00:00:00Z") });
    for (const size of [1, 3, 7]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 30; guard++) {
        const page = await listProjectAudit(reader, projectA, {
          limit: String(size),
          ...(cursor ? { before: cursor } : {}),
        });
        seen.push(...page.entries.map((entry) => entry.action));
        if (!page.next) break;
        cursor = page.next;
      }
      expect(seen.length, `page size ${String(size)}`).toBe(18);
      expect(new Set(seen).size, `page size ${String(size)}`).toBe(18);
      expect(seen.slice(0, 6), `page size ${String(size)}`).toEqual([
        "micro.6",
        "micro.5",
        "micro.4",
        "micro.3",
        "micro.2",
        "micro.1",
      ]);
      expect(seen.slice(-2)).toEqual(["old.one", "old.two"]);
    }
  });
  it("refuses a cursor that was not handed out", async () => {
    expect(await outcome(listProjectAudit(reader, projectA, { before: "garbage" }))).toBe(
      "invalid_input",
    );
    const forged = Buffer.from("2026-01-01T00:00:00Z|not-an-id").toString("base64url");
    expect(await outcome(listProjectAudit(reader, projectA, { before: forged }))).toBe(
      "invalid_input",
    );
  });
});
describe("what an entry may show", () => {
  it("cuts a URL to its address, withholds secrets by name, shortens long text and withholds a login name", () => {
    const shown = redactDetail({
      diff: [
        { pointer: "/url", from: "https://user:pw@hooks.example.org/in?token=abc#frag", to: "x" },
        { pointer: "/config/user", from: "support@example.org", to: "help@example.org" },
        { pointer: "/secret", from: "unset", to: "replaced" },
        { pointer: "/name", from: "a".repeat(500), to: "short" },
      ],
      token: "tok_123",
      apiKey: "key_123",
      state: "set",
      count: 3,
    }) as Record<string, unknown>;
    const text = JSON.stringify(shown);
    expect(text).not.toContain("user:pw");
    expect(text).not.toContain("token=abc");
    expect(text).not.toContain("support@example.org");
    expect(text).not.toContain("tok_123");
    expect(text).not.toContain("key_123");
    expect(text).toContain("https://hooks.example.org/in");
    expect(text).toContain("replaced");
    expect(text).toContain('"count":3');
    const diff = shown.diff as { from: string }[];
    expect(diff[3]?.from.length).toBeLessThanOrEqual(201);
    // The pointer stays, so that a reader sees that the login name changed.
    expect(diff[1]).toEqual({ pointer: "/config/user", from: "[withheld]", to: "[withheld]" });
  });
  it("applies the same cut to entries that were written before it existed", async () => {
    await wipe();
    await put(projectA, userId, "webhook.update", {
      detail: {
        diff: [{ pointer: "/url", from: "https://h.example.org/x?key=old-secret", to: "y" }],
      },
    });
    const page = await listProjectAudit(reader, projectA, {});
    expect(JSON.stringify(page.entries)).not.toContain("old-secret");
  });
  it("is not given a query or credentials of a webhook address to store in the first place", async () => {
    await wipe();
    // A development address needs the development stack; CI is not one, the development container is.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_BOOTSTRAP", "true");
    const manager = person("manager", "human", projectA, [
      "project.read",
      "integration.manage",
      "config.read",
      "config.write",
      "config.approve",
    ]);
    await createWebhook(manager, projectA, {
      name: "Receiver",
      url: "http://localhost:3999/hook?token=write-side-secret",
      events: ["ticket.created"],
      secret: `whsec_${randomUUID()}`,
      developmentOnly: true,
      idempotencyKey: randomUUID(),
    });
    const rows = await db()
      .select({ detail: audit.detail })
      .from(audit)
      .where(and(eq(audit.projectId, projectA), eq(audit.action, "webhook.create")));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain("write-side-secret");
    expect(JSON.stringify(rows)).toContain("http://localhost:3999/hook");
  });
});
describe("export", () => {
  it("writes a table file with the filters, protects cells that a spreadsheet would run, and audits itself", async () => {
    await wipe();
    await db().update(user).set({ name: "=HYPERLINK(1)" }).where(eq(user.id, userId));
    await put(projectA, userId, "ticket.status", {
      target: "t1",
      detail: { note: 'a "quoted", text' },
    });
    await put(projectA, userId, "ticket.assign", { target: "t2" });
    const file = await exportProjectAudit(reader, projectA, { action: "ticket.status" });
    await db().update(user).set({ name: "Ada Auditor" }).where(eq(user.id, userId));
    const lines = file.content.toString("utf8").trimEnd().split("\r\n");
    expect(lines[0]).toBe("time,actor_id,actor_name,actor_kind,action,target_id,detail");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("'=HYPERLINK(1)");
    expect(lines[1]).not.toContain(",=HYPERLINK");
    // The JSON of the detail has its own escaping of the quotes, and the table file doubles every quote again.
    expect(lines[1]).toContain('\\""quoted\\""');
    expect(file.filename).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(file.cut).toBe(false);
    const written = (await listProjectAudit(reader, projectA, { action: "audit.export" })).entries;
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actorId: reader.id,
      detail: { entries: 1, cut: false, filter: { action: "ticket.status" } },
    });
  });
  it("says that an export was cut at its limit", async () => {
    await wipe();
    await db().execute(sql`insert into audit (project_id, actor_id, action, created_at)
      select ${projectA}, ${userId}, 'bulk.entry', now() - (g || ' seconds')::interval
      from generate_series(1, 10001) as g`);
    const file = await exportProjectAudit(reader, projectA, {});
    expect(file.cut).toBe(true);
    expect(file.content.toString("utf8").trimEnd().split("\r\n")).toHaveLength(10_001);
    await wipe();
  });
  it("exports the workspace for the owner only, and audits that", async () => {
    await put(null, `owner-${run}`, "owner.test_entry");
    const file = await exportWorkspaceAudit(owner, { actor: `owner-${run}` });
    expect(file.content.toString("utf8")).toContain("owner.test_entry");
    const written = await listWorkspaceAudit(owner, { action: "audit.export", actor: owner.id });
    expect(written.entries.length).toBeGreaterThan(0);
  });
});
describe("the switches of the workspace", () => {
  it("leave an entry in the audit of the workspace", async () => {
    const before = await db()
      .select({ id: audit.id })
      .from(audit)
      .where(and(isNull(audit.projectId), eq(audit.action, "workspace.controls")));
    // The same value again: the test changes nothing for the other tests, and the entry is written anyway.
    const current = await getWorkspaceControls(owner);
    await setWorkspaceControls(owner, { pauseOutgoing: current.pauseOutgoing });
    const after = await db()
      .select({ id: audit.id, actorId: audit.actorId, detail: audit.detail })
      .from(audit)
      .where(and(isNull(audit.projectId), eq(audit.action, "workspace.controls")));
    expect(after.length).toBe(before.length + 1);
    const mine = after.find((row) => row.actorId === owner.id);
    expect(mine?.detail).toMatchObject({ after: { pauseOutgoing: current.pauseOutgoing } });
  });
});
