import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ImapFlow } from "imapflow";
import { S3Client } from "@aws-sdk/client-s3";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ZodError } from "zod";
import { db, sqlClient } from "../src/server/db";
import { audit, configChanges, connections, projects } from "../src/server/db/schema";
import {
  createConnection,
  disableConnection,
  failureCode,
  listConnections,
  testConnection,
  updateConnection,
} from "../src/server/connections";
import {
  decideConfigChange,
  getConfig,
  listConfigChanges,
  putConfig,
} from "../src/server/configuration";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
import { hostRefused } from "../src/domain/hosts";
import type { Action, Principal } from "../src/domain/permissions";
import { startFakeSmtp, type FakeSmtp } from "./support/smtp";
const projectId = randomUUID();
const otherProject = randomUUID();
const person = (
  name: string,
  kind: "human" | "agent",
  held: Action[],
  project = projectId,
): Principal => ({
  id: `${name}-${projectId}`,
  kind,
  active: true,
  owner: false,
  grants: [{ projectId: project, actions: held }],
});
const all: Action[] = [
  "project.read",
  "integration.manage",
  "config.read",
  "config.write",
  "config.approve",
];
const manager = person("manager", "human", all);
const agent = person("agent", "agent", [
  "project.read",
  "integration.manage",
  "config.read",
  "config.write",
]);
const plain = person("plain", "human", ["project.read", "config.read"]);
const elsewhere = person("elsewhere", "human", all, otherProject);
const secretWord = `pw-${randomUUID()}`;
const imap = (extra: Record<string, unknown> = {}) => ({
  kind: "imap",
  direction: "inbound",
  name: "Support mailbox",
  config: { host: "mail.example.test", port: 993, secure: true, user: "support@example.test" },
  secret: { pass: secretWord },
  ...extra,
});
const smtp = (extra: Record<string, unknown> = {}) => ({
  kind: "smtp",
  direction: "outbound",
  name: "Outgoing",
  config: {
    host: "smtp.example.test",
    port: 587,
    secure: false,
    from: "help@example.test",
    replyTo: "help@example.test",
  },
  secret: { user: "u", pass: secretWord },
  ...extra,
});
let fake: FakeSmtp;
async function reset() {
  await db().delete(configChanges).where(eq(configChanges.projectId, projectId));
  await db().delete(connections).where(eq(connections.projectId, projectId));
  await db()
    .update(projects)
    .set({ settings: {}, configVersion: 1 })
    .where(eq(projects.id, projectId));
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Connections", slug: `conn-${projectId}` },
      { id: otherProject, name: "Other", slug: `conn-${otherProject}` },
    ]);
  fake = await startFakeSmtp();
});
afterAll(async () => {
  await fake.close();
  const ids = [projectId, otherProject];
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("hosts that a connection may not point at", () => {
  it("refuses the machine itself and the metadata range, and allows private networks", () => {
    for (const host of [
      "localhost",
      "x.localhost",
      "127.0.0.1",
      "0.0.0.0",
      "169.254.169.254",
      "::1",
      "[::1]",
      "fe80::1",
      "metadata.google.internal",
    ])
      expect(hostRefused(host), host).toBe(true);
    for (const host of [
      "mail.example.test",
      "10.0.0.5",
      "192.168.1.2",
      "172.16.0.1",
      "2001:db8::1",
    ])
      expect(hostRefused(host), host).toBe(false);
  });
});
describe("defining a connection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("applies for a person, stays a draft, and never shows or stores the secret in the clear", async () => {
    await reset();
    const result = await createConnection(manager, projectId, imap());
    expect(result).toMatchObject({ outcome: "applied", version: 1, validated: false });
    const [row] = await db().select().from(connections).where(eq(connections.projectId, projectId));
    expect(row).toMatchObject({ status: "draft", kind: "imap", direction: "inbound", version: 1 });
    expect(row?.secretCiphertext).toMatch(/^v1:/);
    expect(row?.secretCiphertext).not.toContain(secretWord);
    const listed = await listConnections(manager, projectId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      secretSet: true,
      usedForOutgoingMail: false,
      status: "draft",
    });
    const everything = JSON.stringify([
      listed,
      result,
      await listConfigChanges(manager, projectId),
      await db().select().from(audit).where(eq(audit.projectId, projectId)),
      await db().select().from(configChanges).where(eq(configChanges.projectId, projectId)),
    ]);
    expect(everything).not.toContain(secretWord);
  });
  it("accepts a development-only connection on a development stack only", async () => {
    await reset();
    const local = imap({
      config: {
        host: "mail.example.test",
        port: 143,
        secure: false,
        user: "u",
        developmentOnly: true,
      },
    });
    vi.stubEnv("DEV_BOOTSTRAP", "false");
    await expect(createConnection(manager, projectId, local)).rejects.toBeInstanceOf(ZodError);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_BOOTSTRAP", "true");
    expect((await createConnection(manager, projectId, local)).outcome).toBe("applied");
  });
  it("checks each kind against the rules its adapter enforces", async () => {
    vi.stubEnv("DEV_BOOTSTRAP", "false");
    await reset();
    const refused = async (body: unknown, pointer: string) => {
      const error = await createConnection(manager, projectId, body).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ZodError);
      expect(JSON.stringify((error as ZodError).issues.map((issue) => issue.path))).toContain(
        pointer,
      );
    };
    await refused(
      imap({ config: { host: "mail.example.test", port: 143, secure: false, user: "u" } }),
      "secure",
    );
    await refused(
      imap({ config: { host: "127.0.0.1", port: 993, secure: true, user: "u" } }),
      "host",
    );
    await refused(
      imap({
        config: {
          host: "mail.example.test",
          port: 993,
          secure: true,
          user: "u",
          developmentOnly: true,
        },
      }),
      "developmentOnly",
    );
    await refused(imap({ secret: undefined }), "secret");
    await refused(
      smtp({
        config: {
          host: "smtp.example.test",
          port: 25,
          secure: false,
          from: "a@example.test",
          replyTo: "a@example.test",
        },
      }),
      "port",
    );
    await refused(
      smtp({
        config: {
          host: "169.254.169.254",
          port: 587,
          secure: false,
          from: "a@example.test",
          replyTo: "a@example.test",
        },
      }),
      "host",
    );
    await refused(
      {
        kind: "cloudflare",
        direction: "inbound",
        name: "R2",
        config: { endpoint: "http://r2.example.test", bucket: "b", address: "a@example.test" },
        secret: { accessKeyId: "k", secretAccessKey: "s" },
      },
      "endpoint",
    );
    await expect(
      createConnection(manager, projectId, { ...imap(), kind: "pigeon" }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      createConnection(manager, projectId, { ...imap(), direction: "outbound" }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await listConnections(manager, projectId)).toEqual([]);
    // Valid definitions of all four kinds.
    expect((await createConnection(manager, projectId, smtp({ secret: undefined }))).outcome).toBe(
      "applied",
    );
    expect(
      (
        await createConnection(manager, projectId, {
          kind: "cloudflare",
          direction: "outbound",
          name: "CF out",
          config: { accountId: "a".repeat(32), from: "a@example.test", replyTo: "a@example.test" },
          secret: { apiToken: "t" },
        })
      ).outcome,
    ).toBe("applied");
    expect(
      (
        await createConnection(manager, projectId, {
          kind: "cloudflare",
          direction: "inbound",
          name: "CF in",
          config: { endpoint: "https://r2.example.test", bucket: "b", address: "a@example.test" },
          secret: { accessKeyId: "k", secretAccessKey: "s" },
        })
      ).outcome,
    ).toBe("applied");
  });
  it("needs integration.manage and answers not_found for another project", async () => {
    await reset();
    await expect(createConnection(plain, projectId, imap())).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(listConnections(plain, projectId)).rejects.toMatchObject({ code: "not_found" });
    await expect(createConnection(elsewhere, projectId, imap())).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("validates without writing, and a repeated request creates one connection", async () => {
    await reset();
    expect(await createConnection(manager, projectId, imap(), { validate: true })).toMatchObject({
      outcome: "applied",
      validated: true,
      connectionId: null,
    });
    expect(await listConnections(manager, projectId)).toEqual([]);
    const key = randomUUID();
    const first = await createConnection(manager, projectId, imap({ idempotencyKey: key }));
    expect(await createConnection(manager, projectId, imap({ idempotencyKey: key }))).toEqual(
      first,
    );
    expect(await listConnections(manager, projectId)).toHaveLength(1);
    await expect(
      createConnection(agent, projectId, imap({ idempotencyKey: key })),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});
describe("changing and disabling", () => {
  it("raises the version, returns the connection to draft, keeps the secret unless replaced", async () => {
    await reset();
    const created = await createConnection(manager, projectId, smtp());
    const id = created.connectionId ?? "";
    await db().update(connections).set({ status: "ready" }).where(eq(connections.id, id));
    const [before] = await db().select().from(connections).where(eq(connections.id, id));
    const renamed = await updateConnection(manager, projectId, id, {
      expectedVersion: 1,
      name: "Renamed",
    });
    expect(renamed).toMatchObject({
      outcome: "applied",
      version: 2,
      diff: [{ pointer: "/name", from: "Outgoing", to: "Renamed" }],
    });
    const [after] = await db().select().from(connections).where(eq(connections.id, id));
    expect(after).toMatchObject({ name: "Renamed", status: "draft", version: 2 });
    expect(after?.secretCiphertext).toBe(before?.secretCiphertext);
    const replaced = await updateConnection(manager, projectId, id, {
      expectedVersion: 2,
      secret: { user: "u", pass: "new-pass" },
    });
    expect(replaced.diff).toEqual([{ pointer: "/secret", from: "set", to: "replaced" }]);
    const [changed] = await db().select().from(connections).where(eq(connections.id, id));
    expect(changed?.secretCiphertext).not.toBe(before?.secretCiphertext);
    expect(JSON.stringify(replaced)).not.toContain("new-pass");
    const moved = await updateConnection(manager, projectId, id, {
      expectedVersion: 3,
      config: { ...(before?.config ?? {}), port: 465, secure: true },
    });
    expect(moved.diff.map((entry) => entry.pointer).sort()).toEqual([
      "/config/port",
      "/config/secure",
    ]);
    expect(await updateConnection(manager, projectId, id, { expectedVersion: 4 })).toMatchObject({
      outcome: "unchanged",
      version: 4,
    });
  });
  it("refuses a stale version, an invalid configuration and a connection of another project", async () => {
    await reset();
    const id = (await createConnection(manager, projectId, smtp())).connectionId ?? "";
    await updateConnection(manager, projectId, id, { expectedVersion: 1, name: "One" });
    await expect(
      updateConnection(manager, projectId, id, { expectedVersion: 1, name: "Two" }),
    ).rejects.toMatchObject({ code: "stale_version" });
    await expect(
      updateConnection(manager, projectId, id, { expectedVersion: 2, config: { host: "x" } }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      updateConnection(manager, otherProject, id, { expectedVersion: 2, name: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      updateConnection(elsewhere, otherProject, id, { expectedVersion: 2, name: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("disables, and a disabled connection is not tested", async () => {
    await reset();
    const id = (await createConnection(manager, projectId, smtp())).connectionId ?? "";
    expect(await disableConnection(manager, projectId, id, { expectedVersion: 1 })).toMatchObject({
      outcome: "applied",
      version: 2,
    });
    expect((await listConnections(manager, projectId))[0]?.status).toBe("disabled");
    expect(await disableConnection(manager, projectId, id, { expectedVersion: 2 })).toMatchObject({
      outcome: "unchanged",
    });
    await expect(testConnection(manager, projectId, id)).rejects.toMatchObject({
      code: "conflict",
    });
  });
});
describe("an agent under the review policy", () => {
  it("proposes a connection with its secret sealed, and a person activates it", async () => {
    await reset();
    const proposed = await createConnection(agent, projectId, imap());
    expect(proposed).toMatchObject({ outcome: "proposed", connectionId: null });
    expect(await listConnections(manager, projectId)).toEqual([]);
    const [stored] = await db()
      .select()
      .from(configChanges)
      .where(eq(configChanges.id, proposed.changeId ?? ""));
    expect(stored).toMatchObject({ kind: "connection.create", status: "pending" });
    expect(JSON.stringify(stored)).not.toContain(secretWord);
    expect(JSON.stringify(stored?.payload)).toContain("v1:");
    await expect(
      decideConfigChange(agent, proposed.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await decideConfigChange(manager, proposed.changeId ?? "", { decision: "approve" }),
    ).toMatchObject({ status: "applied", version: 1 });
    const [connection] = await listConnections(manager, projectId);
    expect(connection).toMatchObject({ name: "Support mailbox", status: "draft", secretSet: true });
    const [done] = await db()
      .select()
      .from(configChanges)
      .where(eq(configChanges.id, proposed.changeId ?? ""));
    expect(done?.target).toBe(connection?.id);
  });
  it("proposes changes and disabling, and a change on an older version is refused", async () => {
    await reset();
    const id = (await createConnection(manager, projectId, smtp())).connectionId ?? "";
    const rename = await updateConnection(agent, projectId, id, {
      expectedVersion: 1,
      name: "By agent",
    });
    const disable = await disableConnection(agent, projectId, id, { expectedVersion: 1 });
    expect([rename.outcome, disable.outcome]).toEqual(["proposed", "proposed"]);
    expect((await listConnections(manager, projectId))[0]).toMatchObject({
      name: "Outgoing",
      status: "draft",
    });
    // The first one is approved; the second was made on the old version.
    await decideConfigChange(manager, rename.changeId ?? "", { decision: "approve" });
    await expect(
      decideConfigChange(manager, disable.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "stale_version" });
    expect((await listConnections(manager, projectId))[0]).toMatchObject({
      name: "By agent",
      status: "draft",
      version: 2,
    });
    expect(
      (await listConfigChanges(manager, projectId, "superseded")).map((entry) => entry.id),
    ).toContain(disable.changeId);
    const rejected = await disableConnection(agent, projectId, id, { expectedVersion: 2 });
    await decideConfigChange(manager, rejected.changeId ?? "", { decision: "reject" });
    expect((await listConnections(manager, projectId))[0]?.status).toBe("draft");
  });
  it("applies at once under the direct policy", async () => {
    await reset();
    await putConfig(manager, projectId, {
      config: { ...(await getConfig(manager, projectId)).config, approvalPolicy: "direct" },
      expectedVersion: 1,
    });
    expect(await createConnection(agent, projectId, smtp())).toMatchObject({ outcome: "applied" });
    expect(await listConnections(manager, projectId)).toHaveLength(1);
  });
});
describe("the outgoing connection of the configuration", () => {
  it("must be an outgoing connection of the project that is not disabled", async () => {
    await reset();
    const out = (await createConnection(manager, projectId, smtp())).connectionId ?? "";
    const inbound = (await createConnection(manager, projectId, imap())).connectionId ?? "";
    const foreign = randomUUID();
    const config = (await getConfig(manager, projectId)).config;
    for (const bad of [inbound, foreign])
      await expect(
        putConfig(manager, projectId, {
          config: { ...config, outboundConnectionId: bad },
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(ZodError);
    const set = await putConfig(manager, projectId, {
      config: { ...config, outboundConnectionId: out, pauseOutgoing: true },
      expectedVersion: 1,
    });
    expect(set.diff.map((entry) => entry.pointer).sort()).toEqual([
      "/outboundConnectionId",
      "/pauseOutgoing",
    ]);
    expect(
      (await listConnections(manager, projectId)).find((entry) => entry.id === out)
        ?.usedForOutgoingMail,
    ).toBe(true);
    await disableConnection(manager, projectId, out, { expectedVersion: 1 });
    await expect(
      putConfig(manager, projectId, {
        config: { ...config, outboundConnectionId: out, pauseOutgoing: false },
        expectedVersion: 2,
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
describe("testing a connection", () => {
  it("records ready after a successful check and degraded with a code after a failed one", async () => {
    await reset();
    const [ok] = await db()
      .insert(connections)
      .values({
        projectId,
        kind: "smtp",
        direction: "outbound",
        name: "Fake",
        config: {
          host: "127.0.0.1",
          port: fake.port,
          secure: false,
          from: "a@example.test",
          replyTo: "a@example.test",
          developmentOnly: true,
        },
      })
      .returning();
    expect(await testConnection(manager, projectId, ok?.id ?? "")).toMatchObject({
      status: "ready",
      lastErrorCode: null,
    });
    expect((await listConnections(manager, projectId))[0]).toMatchObject({
      status: "ready",
      lastErrorCode: null,
    });
    await db()
      .update(connections)
      .set({
        config: {
          host: "127.0.0.1",
          port: 1,
          secure: false,
          from: "a@example.test",
          replyTo: "a@example.test",
          developmentOnly: true,
        },
      })
      .where(eq(connections.id, ok?.id ?? ""));
    const failed = await testConnection(agent, projectId, ok?.id ?? "");
    expect(failed).toMatchObject({ status: "degraded", lastErrorCode: "connect_failed" });
    expect(JSON.stringify(failed)).not.toContain("127.0.0.1");
    expect((await listConnections(manager, projectId))[0]).toMatchObject({
      status: "degraded",
      lastErrorCode: "connect_failed",
    });
    await expect(testConnection(plain, projectId, ok?.id ?? "")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(testConnection(manager, projectId, randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("maps failures to codes that name no host or credential", () => {
    expect(failureCode(Object.assign(new Error("x"), { code: "EAUTH" }))).toBe("auth_failed");
    expect(failureCode(Object.assign(new Error("x"), { authenticationFailed: true }))).toBe(
      "auth_failed",
    );
    expect(failureCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(
      "connect_failed",
    );
    expect(failureCode(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe(
      "connect_failed",
    );
    expect(failureCode(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("timeout");
    expect(
      failureCode(Object.assign(new Error("x"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })),
    ).toBe("tls_failed");
    expect(failureCode(Object.assign(new Error("x"), { name: "NoSuchBucket" }))).toBe("not_found");
    expect(failureCode(Object.assign(new Error("x"), { name: "InvalidAccessKeyId" }))).toBe(
      "auth_failed",
    );
    expect(failureCode(new Error("secret-in-message"))).toBe("failed");
  });
});

const addressOf = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
describe("the checks of the other kinds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  async function stored(
    kind: string,
    direction: string,
    config: Record<string, unknown>,
    secret: Record<string, unknown>,
  ) {
    await reset();
    const [row] = await db()
      .insert(connections)
      .values({
        projectId,
        kind,
        direction,
        name: kind,
        config,
        secretCiphertext: seal(JSON.stringify(secret), env().ENCRYPTION_KEY),
      })
      .returning();
    return row?.id ?? "";
  }
  it("logs in to the mailbox of an IMAP connection", async () => {
    const id = await stored(
      "imap",
      "inbound",
      { host: "mail.example.test", port: 993, secure: true, user: "u", mailbox: "INBOX" },
      { pass: "p" },
    );
    const connect = vi.spyOn(ImapFlow.prototype, "connect").mockResolvedValue(undefined);
    const lock = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockResolvedValue({
      path: "INBOX",
      release: () => undefined,
    });
    const logout = vi.spyOn(ImapFlow.prototype, "logout").mockResolvedValue(undefined);
    expect(await testConnection(manager, projectId, id)).toMatchObject({ status: "ready" });
    expect(lock).toHaveBeenCalledWith("INBOX");
    expect(logout).toHaveBeenCalled();
    connect.mockRejectedValue(
      Object.assign(new Error("Invalid credentials"), { authenticationFailed: true }),
    );
    const failed = await testConnection(manager, projectId, id);
    expect(failed).toMatchObject({ status: "degraded", lastErrorCode: "auth_failed" });
    expect(JSON.stringify(failed)).not.toContain("credentials");
  });
  it("lists the bucket of a Cloudflare inbound connection", async () => {
    const id = await stored(
      "cloudflare",
      "inbound",
      {
        endpoint: "https://r2.example.test",
        bucket: "mail",
        address: "a@example.test",
        region: "auto",
      },
      { accessKeyId: "k", secretAccessKey: "s" },
    );
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({} as never);
    expect(await testConnection(manager, projectId, id)).toMatchObject({ status: "ready" });
    send.mockRejectedValue(Object.assign(new Error("gone"), { name: "NoSuchBucket" }));
    expect(await testConnection(manager, projectId, id)).toMatchObject({
      status: "degraded",
      lastErrorCode: "not_found",
    });
  });
  it("asks Cloudflare whether the token of an outgoing connection is active", async () => {
    const id = await stored(
      "cloudflare",
      "outbound",
      { accountId: "a".repeat(32), from: "a@example.test", replyTo: "a@example.test" },
      { apiToken: "token-value" },
    );
    const reply = (status: number, active: boolean) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: active, result: { status: active ? "active" : "disabled" } }),
          { status },
        ),
      );
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(() => reply(200, true));
    expect(await testConnection(manager, projectId, id)).toMatchObject({ status: "ready" });
    // A user token is not known to the account endpoint but to the user endpoint.
    fetched.mockImplementation((input) =>
      addressOf(input).includes("/accounts/") ? reply(403, false) : reply(200, true),
    );
    expect(await testConnection(manager, projectId, id)).toMatchObject({ status: "ready" });
    fetched.mockImplementation(() => reply(401, false));
    const failed = await testConnection(manager, projectId, id);
    expect(failed).toMatchObject({ status: "degraded", lastErrorCode: "auth_failed" });
    expect(JSON.stringify(failed)).not.toContain("token-value");
  });
});

describe("remaining paths", () => {
  it("answers not_found for a project that does not exist and reports a validated disable and update", async () => {
    const ghost = randomUUID();
    const ghostManager: Principal = { ...manager, grants: [{ projectId: ghost, actions: all }] };
    await expect(listConnections(ghostManager, ghost)).rejects.toMatchObject({ code: "not_found" });
    await reset();
    const id = (await createConnection(manager, projectId, smtp())).connectionId ?? "";
    expect(
      await disableConnection(manager, projectId, id, { expectedVersion: 1 }, { validate: true }),
    ).toMatchObject({ outcome: "applied", validated: true, version: 1 });
    expect(
      await disableConnection(agent, projectId, id, { expectedVersion: 1 }, { validate: true }),
    ).toMatchObject({ outcome: "proposed", validated: true });
    expect(
      await updateConnection(
        manager,
        projectId,
        id,
        { expectedVersion: 1, name: "X" },
        { validate: true },
      ),
    ).toMatchObject({ outcome: "applied", validated: true, changeId: null });
    expect((await listConnections(manager, projectId))[0]?.name).toBe("Outgoing");
  });
  it("returns the same proposal when an agent repeats a request", async () => {
    await reset();
    const key = randomUUID();
    const first = await createConnection(agent, projectId, imap({ idempotencyKey: key }));
    expect(first.outcome).toBe("proposed");
    expect(await createConnection(agent, projectId, imap({ idempotencyKey: key }))).toEqual(first);
    expect(await listConfigChanges(manager, projectId, "pending")).toHaveLength(1);
  });
  it("classifies odd failures", () => {
    expect(failureCode({})).toBe("failed");
    expect(failureCode(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
    expect(failureCode({ cause: { code: "ECONNREFUSED" } })).toBe("connect_failed");
  });
});
