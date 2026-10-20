import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  aiProfiles,
  audit,
  configChanges,
  connections,
  projects,
  webhooks,
} from "../src/server/db/schema";
import { exportProcessing, getProcessing, listProcessing } from "../src/server/processing";
import { defaultAiHost, hostOf, taskContent } from "../src/domain/processing";
import { aiTasks } from "../src/domain/ai";
import type { Action, Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectId = randomUUID();
const bareId = randomUUID();
const archivedId = randomUUID();
const outboundId = randomUUID();
const hookId = randomUUID();
const person = (project: string, held: Action[], extra: Partial<Principal> = {}): Principal => ({
  id: `proc-${run}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId: project, actions: held }],
  ...extra,
});
const reader = person(projectId, ["project.read", "config.read"]);
const noConfig = person(projectId, ["project.read", "ticket.read"]);
const outsider = person(bareId, ["config.read"]);
const entryOf = async (group: string, id?: string, task?: string) =>
  (await getProcessing(reader, projectId)).entries.find(
    (entry) =>
      entry.group === group &&
      (id === undefined || entry.id === id) &&
      (task === undefined || entry.task === task),
  );
const connection = (
  values: Partial<typeof connections.$inferInsert> &
    Pick<typeof connections.$inferInsert, "kind" | "direction" | "name">,
) => ({
  projectId,
  status: "ready",
  config: {},
  ...values,
});
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      {
        id: projectId,
        name: "Processing",
        slug: `proc-${run}`,
        settings: { outboundConnectionId: outboundId, acknowledgements: true },
      },
      { id: bareId, name: "Bare", slug: `proc-bare-${run}`, settings: { acknowledgements: true } },
      { id: archivedId, name: "Archived", slug: `proc-arch-${run}`, archivedAt: new Date() },
    ]);
  const [anthropic, openai, junkConnection] = (
    await db()
      .insert(connections)
      .values([
        connection({ kind: "anthropic", direction: "ai", name: "Claude" }),
        connection({
          kind: "openai",
          direction: "ai",
          name: "Gateway",
          config: { endpoint: "https://gateway.example.test/v1" },
        }),
        connection({ kind: "google", direction: "ai", name: "Draft only", status: "draft" }),
        connection({
          kind: "github",
          direction: "knowledge",
          name: "Issues",
          config: { repositories: ["acme/app"], endpoint: "https://git.example.test/api/v3" },
        }),
        connection({
          kind: "docs",
          direction: "knowledge",
          name: "Docs",
          config: {
            pages: [
              { title: "A", url: "https://docs.example.test/a" },
              { title: "B", url: "https://help.example.test/b" },
            ],
          },
        }),
        connection({
          kind: "context",
          direction: "knowledge",
          name: "Customers",
          config: { endpoint: "https://crm.example.test/lookup" },
        }),
      ])
      .returning({ id: connections.id })
  ).map((row) => row.id);
  await db()
    .insert(connections)
    .values([
      connection({
        id: outboundId,
        kind: "smtp",
        direction: "outbound",
        name: "Mail",
        config: { host: "smtp.example.test" },
      }),
      connection({
        kind: "cloudflare",
        direction: "outbound",
        name: "Spare",
        config: { accountId: "a".repeat(32) },
      }),
      connection({
        kind: "imap",
        direction: "inbound",
        name: "Mailbox",
        config: { host: "imap.example.test" },
      }),
      connection({
        kind: "cloudflare",
        direction: "inbound",
        name: "Routing",
        config: { endpoint: "https://r2.example.test", bucket: "mail" },
      }),
      connection({
        kind: "smtp",
        direction: "outbound",
        name: "=Formula",
        config: { host: "x.example.test" },
      }),
    ]);
  const profile = (task: string, connectionId: string | undefined, enabled: boolean) => ({
    projectId,
    task,
    connectionId: connectionId ?? "",
    model: "model-1",
    timeoutSeconds: 20,
    maxOutputTokens: 500,
    dailyTokenBudget: 1000,
    enabled,
  });
  await db()
    .insert(aiProfiles)
    .values([
      profile("reply.draft", anthropic, true),
      profile("note.draft", openai, false),
      profile("intake.junk", junkConnection, true),
    ]);
  await db()
    .insert(webhooks)
    .values([
      {
        id: hookId,
        projectId,
        name: "Hook",
        url: "https://hooks.example.test/in",
        events: ["ticket.created", "ticket.overdue"],
        secretCiphertext: "x",
      },
      {
        projectId,
        name: "Quiet",
        url: "https://other.example.test/in",
        events: ["ticket.overdue"],
        secretCiphertext: "x",
        status: "disabled",
      },
    ]);
}, 60_000);
afterAll(async () => {
  const ids = [projectId, bareId, archivedId];
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(configChanges).where(inArray(configChanges.projectId, ids));
  await db().delete(webhooks).where(inArray(webhooks.projectId, ids));
  await db().delete(aiProfiles).where(inArray(aiProfiles.projectId, ids));
  await db().delete(connections).where(inArray(connections.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("what is said about the content", () => {
  it("names the content of every task and knows the hosts of the providers", () => {
    expect(Object.keys(taskContent).sort()).toEqual([...aiTasks].sort());
    expect(taskContent["note.draft"]).toContain("notes");
    expect(taskContent["reply.draft"]).not.toContain("notes");
    expect(taskContent["intake.junk"]).toContain("customer_address");
    expect(hostOf("https://api.example.test:8443/path")).toBe("api.example.test:8443");
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(undefined)).toBeNull();
    expect(defaultAiHost.anthropic).toBe("api.anthropic.com");
  });
});
describe("the overview of a project", () => {
  it("lists the outgoing mail with its host, what it receives and which connection the project uses", async () => {
    const used = await entryOf("mail_out", outboundId);
    expect(used).toMatchObject({
      kind: "smtp",
      host: "smtp.example.test",
      state: "active",
      issues: [],
    });
    expect(used?.receives).toEqual(
      expect.arrayContaining(["conversation", "customer_address", "subject"]),
    );
    const spare = (await getProcessing(reader, projectId)).entries.find(
      (entry) => entry.name === "Spare",
    );
    expect(spare).toMatchObject({
      kind: "cloudflare",
      host: "api.cloudflare.com",
      state: "unused",
    });
    expect(spare?.detail).toContain("account");
  });
  it("lists the incoming mail and where a raw mail is stored", async () => {
    expect(await entryOf("mail_in", undefined)).toBeDefined();
    const inbound = (await getProcessing(reader, projectId)).entries.filter(
      (entry) => entry.group === "mail_in",
    );
    expect(inbound.map((entry) => [entry.kind, entry.host])).toEqual(
      expect.arrayContaining([
        ["imap", "imap.example.test"],
        ["cloudflare", "r2.example.test"],
      ]),
    );
    expect(inbound.find((entry) => entry.kind === "cloudflare")?.receives).toEqual(["raw_mail"]);
    expect(inbound.find((entry) => entry.kind === "imap")?.receives).toEqual([]);
  });
  it("lists a model for every task, with the host of the provider, and what is not set up sends nothing", async () => {
    const all = (await getProcessing(reader, projectId)).entries.filter(
      (entry) => entry.group === "ai",
    );
    expect(all.map((entry) => entry.task).sort()).toEqual([...aiTasks].sort());
    const reply = all.find((entry) => entry.task === "reply.draft");
    expect(reply).toMatchObject({
      kind: "anthropic",
      host: "api.anthropic.com",
      detail: "model-1",
      state: "active",
      issues: [],
    });
    expect(reply?.receives).toEqual([...taskContent["reply.draft"]]);
    const note = all.find((entry) => entry.task === "note.draft");
    expect(note).toMatchObject({
      kind: "openai",
      host: "gateway.example.test",
      state: "off",
      issues: [],
    });
    const junk = all.find((entry) => entry.task === "intake.junk");
    expect(junk).toMatchObject({
      kind: "google",
      host: "generativelanguage.googleapis.com",
      state: "active",
      issues: ["not_ready"],
    });
    const none = all.find((entry) => entry.task === "image.read");
    expect(none).toMatchObject({
      kind: "none",
      host: null,
      state: "not_set_up",
      receives: [],
      issues: [],
    });
  });
  it("lists the sources of knowledge with their hosts and what they get", async () => {
    const sources = (await getProcessing(reader, projectId)).entries.filter(
      (entry) => entry.group === "knowledge",
    );
    const byKind = (kind: string) => sources.find((entry) => entry.kind === kind);
    expect(byKind("github")).toMatchObject({
      host: "git.example.test",
      detail: "acme/app",
      receives: ["search_words"],
    });
    expect(byKind("docs")?.host).toBe("docs.example.test, help.example.test");
    expect(byKind("context")).toMatchObject({
      host: "crm.example.test",
      receives: ["search_words", "customer_address"],
    });
  });
  it("lists the webhooks with what an event carries, and a disabled one as off", async () => {
    const hooks = (await getProcessing(reader, projectId)).entries.filter(
      (entry) => entry.group === "webhook",
    );
    expect(hooks.find((entry) => entry.name === "Hook")).toMatchObject({
      host: "hooks.example.test",
      state: "active",
      receives: ["event_facts", "subject"],
    });
    expect(hooks.find((entry) => entry.name === "Quiet")).toMatchObject({
      state: "off",
      receives: ["event_facts"],
    });
  });
  it("marks an entry whose change waits for approval, and counts the entries with issues", async () => {
    const before = await getProcessing(reader, projectId);
    await db().insert(configChanges).values({
      projectId,
      kind: "webhook.update",
      target: hookId,
      baseVersion: 1,
      status: "pending",
      proposedBy: "agent-1",
      proposerKind: "agent",
      payload: {},
      diff: [],
    });
    const after = await getProcessing(reader, projectId);
    expect(after.entries.find((entry) => entry.id === hookId)?.issues).toEqual([
      "approval_pending",
    ]);
    expect(after.pending).toEqual([{ kind: "webhook.update", target: hookId }]);
    expect(after.withIssues).toBe(before.withIssues + 1);
    await db()
      .update(configChanges)
      .set({ status: "applied" })
      .where(eq(configChanges.projectId, projectId));
    expect(
      (await getProcessing(reader, projectId)).entries.find((entry) => entry.id === hookId)?.issues,
    ).toEqual([]);
  });
  it("says when a project has no outgoing connection, with and without acknowledgements, and when mail is paused", async () => {
    const bare = await getProcessing(outsider, bareId);
    expect(bare.entries.find((entry) => entry.group === "mail_out")).toMatchObject({
      state: "not_set_up",
      issues: ["acknowledgements_without_outbound"],
    });
    await db()
      .update(projects)
      .set({ settings: { acknowledgements: false } })
      .where(eq(projects.id, bareId));
    expect(
      (await getProcessing(outsider, bareId)).entries.find((entry) => entry.group === "mail_out")
        ?.issues,
    ).toEqual(["no_outbound"]);
    await db()
      .update(projects)
      .set({
        settings: { outboundConnectionId: outboundId, acknowledgements: true, pauseOutgoing: true },
      })
      .where(eq(projects.id, projectId));
    expect(await entryOf("mail_out", outboundId)).toMatchObject({
      state: "off",
      issues: ["paused"],
    });
    await db()
      .update(projects)
      .set({ settings: { outboundConnectionId: outboundId, acknowledgements: true } })
      .where(eq(projects.id, projectId));
    await db()
      .update(connections)
      .set({ status: "degraded" })
      .where(eq(connections.id, outboundId));
    expect(await entryOf("mail_out", outboundId)).toMatchObject({
      state: "active",
      issues: ["not_ready"],
    });
    await db().update(connections).set({ status: "ready" }).where(eq(connections.id, outboundId));
  });
});
describe("who may read it", () => {
  it("needs the right to read the configuration of the project", async () => {
    for (const run of [
      () => getProcessing(noConfig, projectId),
      () => getProcessing(outsider, projectId),
      () => exportProcessing(noConfig, projectId),
    ])
      await expect(run()).rejects.toMatchObject({ code: "not_found" });
    expect((await getProcessing({ ...reader, kind: "agent" }, projectId)).name).toBe("Processing");
    await expect(getProcessing(reader, randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });
  it("lists the projects that the caller may read, by name, without archived ones", async () => {
    const both: Principal = {
      ...reader,
      grants: [
        { projectId, actions: ["config.read"] },
        { projectId: bareId, actions: ["config.read"] },
        { projectId: archivedId, actions: ["config.read"] },
      ],
    };
    expect((await listProcessing(both)).map((entry) => entry.name)).toEqual(["Bare", "Processing"]);
    expect(await listProcessing(noConfig)).toEqual([]);
    expect((await listProcessing(reader)).map((entry) => entry.name)).toEqual(["Processing"]);
  });
});
describe("the export", () => {
  it("is a file with a line for every entry, writes cells that look like formulas as text, and is audited", async () => {
    await db().delete(audit).where(eq(audit.projectId, projectId));
    const file = await exportProcessing(reader, projectId);
    const text = file.content.toString("utf8");
    const lines = text.trimEnd().split("\r\n");
    expect(lines[0]).toBe("group,name,kind,task,host,detail,receives,state,issues");
    const overview = await getProcessing(reader, projectId);
    expect(lines).toHaveLength(overview.entries.length + 1);
    expect(text).toContain("'=Formula");
    expect(text).not.toMatch(/(^|,)=Formula/m);
    expect(text).toContain("smtp.example.test");
    expect(text).toContain("reply.draft");
    expect(file.filename).toMatch(/^processing-\d{4}-\d{2}-\d{2}\.csv$/);
    const entries = await db().select().from(audit).where(eq(audit.projectId, projectId));
    expect(entries.filter((entry) => entry.action === "processing.export")).toHaveLength(1);
    expect(entries.find((entry) => entry.action === "processing.export")?.detail).toEqual({
      entries: overview.entries.length,
    });
  });
});
