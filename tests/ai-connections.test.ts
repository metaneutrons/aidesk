import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Names resolve through this table; an unknown name resolves to a public address.
const dns = vi.hoisted(() => ({ table: new Map<string, string[]>() }));
vi.mock("node:dns/promises", () => ({
  lookup: (host: string) => {
    const found = dns.table.get(host) ?? ["93.184.216.34"];
    if (found.length === 0)
      return Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" }));
    return Promise.resolve(
      found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
  },
}));
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ZodError } from "zod";
import { db, sqlClient } from "../src/server/db";
import { audit, configChanges, connections, projects } from "../src/server/db/schema";
import {
  createConnection,
  failureCode,
  listConnections,
  testConnection,
} from "../src/server/connections";
import { decideConfigChange, listConfigChanges } from "../src/server/configuration";
import { handle } from "../src/server/api/router";
import { routes } from "../src/server/api/routes";
import { connectionTypes } from "../src/domain/connections";
import * as out from "../src/server/api/schemas";
import type { Action, Principal } from "../src/domain/permissions";
import { startFakeProvider, type FakeProvider } from "./support/provider";
const projectId = randomUUID();
const key = "sk-test-secret-key-value";
const held: Action[] = ["project.read", "integration.manage", "config.read", "config.write"];
const person = (name: string, kind: "human" | "agent", actions: Action[]): Principal => ({
  id: `${name}-${projectId}`,
  kind,
  active: true,
  owner: false,
  grants: [{ projectId, actions }],
});
const manager = person("manager", "human", [...held, "config.approve"]);
const agent = person("agent", "agent", held);
const kinds = [
  { kind: "anthropic", path: "/v1/models", base: "https://api.anthropic.com" },
  { kind: "openai", path: "/v1/models", base: "https://api.openai.com" },
  { kind: "google", path: "/v1beta/models", base: "https://generativelanguage.googleapis.com" },
] as const;
let provider: FakeProvider;
const definition = (kind: string, config: Record<string, unknown> = {}) => ({
  kind,
  direction: "ai",
  name: `${kind} models`,
  config,
  secret: { apiKey: key },
});
async function reset() {
  await db().delete(configChanges).where(eq(configChanges.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(connections).where(eq(connections.projectId, projectId));
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values({ id: projectId, name: "AI", slug: `ai-${projectId}` });
  provider = await startFakeProvider(key);
});
afterAll(async () => {
  await provider.close();
  await reset();
  await db().delete(projects).where(eq(projects.id, projectId));
  await sqlClient().end();
});
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEV_BOOTSTRAP", "true");
  provider.requests.length = 0;
  provider.behaviour = {};
  dns.table.clear();
  await reset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("defining a connection to a model provider", () => {
  it("is a draft with the key sealed, for each of the three providers", async () => {
    for (const { kind } of kinds) {
      const created = await createConnection(manager, projectId, definition(kind));
      expect(created).toMatchObject({ outcome: "applied" });
      // The default address needs no endpoint, and nothing is written in the clear.
      expect(JSON.stringify(created)).not.toContain(key);
    }
    const listed = await listConnections(manager, projectId);
    expect(listed.map((row) => `${row.kind}:${row.direction}`).sort()).toEqual([
      "anthropic:ai",
      "google:ai",
      "openai:ai",
    ]);
    expect(listed.every((row) => row.status === "draft" && row.secretSet)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(key);
    const rows = await db().select().from(connections).where(eq(connections.projectId, projectId));
    expect(rows.every((row) => row.secretCiphertext && !row.secretCiphertext.includes(key))).toBe(
      true,
    );
    expect(
      JSON.stringify(await db().select().from(audit).where(eq(audit.projectId, projectId))),
    ).not.toContain(key);
  });
  it("names the field of a kind that is wrong, and lists the kinds", async () => {
    const wrong = await createConnection(manager, projectId, {
      ...definition("anthropic"),
      secret: {},
    }).catch((error: unknown) => error);
    expect(wrong).toBeInstanceOf(ZodError);
    expect(JSON.stringify((wrong as ZodError).issues.map((issue) => issue.path))).toContain(
      "apiKey",
    );
    const unknown = await createConnection(manager, projectId, definition("mistral")).catch(
      (error: unknown) => error,
    );
    expect(JSON.stringify((unknown as ZodError).issues)).toContain(
      "anthropic/ai, openai/ai, google/ai",
    );
  });
  it("needs HTTPS for another address, refuses a host that is not allowed, and one that does not resolve", async () => {
    vi.stubEnv("DEV_BOOTSTRAP", "false");
    const refusal = async (config: Record<string, unknown>) => {
      const error = await createConnection(manager, projectId, definition("openai", config)).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ZodError);
      return (error as ZodError).issues.map((issue) => `${issue.path.join("/")}: ${issue.message}`);
    };
    expect(await refusal({ endpoint: "http://gateway.example.test" })).toEqual([
      "config/endpoint: HTTPS is required",
    ]);
    dns.table.set("inner.example.test", ["127.0.0.1"]);
    expect(await refusal({ endpoint: "https://inner.example.test" })).toEqual([
      "config/endpoint: This host is not allowed",
    ]);
    dns.table.set("gone.example.test", []);
    expect(await refusal({ endpoint: "https://gone.example.test" })).toEqual([
      "config/endpoint: This host does not resolve",
    ]);
    // A development stack's plain address is a development-only connection.
    expect(await refusal({ endpoint: "http://127.0.0.1:1", developmentOnly: true })).toEqual([
      "config/developmentOnly: Only a development stack accepts this",
    ]);
    // Another address that is allowed, and the default one that needs no check.
    dns.table.set("gateway.example.test", ["93.184.216.34"]);
    expect(
      await createConnection(
        manager,
        projectId,
        definition("openai", { endpoint: "https://gateway.example.test" }),
      ),
    ).toMatchObject({ outcome: "applied" });
    expect(await createConnection(manager, projectId, definition("google"))).toMatchObject({
      outcome: "applied",
    });
  });
  it("is proposed by an agent under the review policy with the key sealed, and a person decides", async () => {
    const proposed = await createConnection(agent, projectId, definition("anthropic"));
    expect(proposed).toMatchObject({ outcome: "proposed" });
    const [change] = await listConfigChanges(manager, projectId, "pending");
    expect(JSON.stringify(change)).not.toContain(key);
    const stored = await db()
      .select()
      .from(configChanges)
      .where(eq(configChanges.projectId, projectId));
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(await listConnections(manager, projectId)).toHaveLength(0);
    await decideConfigChange(manager, change?.id ?? "", { decision: "approve" });
    expect((await listConnections(manager, projectId)).map((row) => row.kind)).toEqual([
      "anthropic",
    ]);
  });
});
describe("the published shape of connections", () => {
  it("lists the connections of a project that has one to a model provider, through the router", async () => {
    for (const { kind } of kinds) await createConnection(manager, projectId, definition(kind));
    // The router checks every answer against its published schema outside
    // production, so a kind the schema does not know is a 500 here.
    const response = await handle(
      new Request(`http://localhost:3000/api/v1/projects/${projectId}/connections`),
      manager,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { kind: string; direction: string }[];
    expect(body.map((row) => `${row.kind}:${row.direction}`).sort()).toEqual([
      "anthropic:ai",
      "google:ai",
      "openai:ai",
    ]);
  });
  it("knows every kind and direction of every connection type in the answer and in the tool", () => {
    const route = routes.find((entry) => entry.id === "connections.create");
    const input = (
      route?.mcp as { input?: Record<string, { safeParse: (v: unknown) => { success: boolean } }> }
    ).input;
    expect(input).toBeDefined();
    for (const key of Object.keys(connectionTypes)) {
      const [kind, direction] = key.split(":");
      expect(out.connectionOut.shape.kind.safeParse(kind).success, key).toBe(true);
      expect(out.connectionOut.shape.direction.safeParse(direction).success, key).toBe(true);
      expect(input?.kind?.safeParse(kind).success, key).toBe(true);
      expect(input?.direction?.safeParse(direction).success, key).toBe(true);
    }
    // And no other one.
    expect(out.connectionOut.shape.kind.safeParse("mistral").success).toBe(false);
    expect(input?.direction?.safeParse("sideways").success).toBe(false);
  });
});
describe("testing a connection to a model provider", () => {
  const withProvider = async (kind: string) => {
    const created = await createConnection(
      manager,
      projectId,
      definition(kind, { endpoint: provider.url, developmentOnly: true }),
    );
    return created.connectionId ?? "";
  };
  it("asks for the list of models with the key in the header the provider names, never in the address", async () => {
    for (const { kind, path } of kinds) {
      provider.requests.length = 0;
      const connectionId = await withProvider(kind);
      expect(await testConnection(manager, projectId, connectionId)).toMatchObject({
        status: "ready",
        lastErrorCode: null,
      });
      expect(provider.requests).toHaveLength(1);
      const [request] = provider.requests;
      expect(request?.method).toBe("GET");
      expect(request?.url).toBe(path);
      expect(request?.url).not.toContain(key);
      const headers = request?.headers ?? {};
      if (kind === "anthropic") {
        expect(headers["x-api-key"]).toBe(key);
        expect(headers["anthropic-version"]).toBe("2023-06-01");
      }
      if (kind === "openai") expect(headers.authorization).toBe(`Bearer ${key}`);
      if (kind === "google") expect(headers["x-goog-api-key"]).toBe(key);
    }
  });
  it("uses the address of the provider when the connection names none", async () => {
    for (const { kind, path, base } of kinds) {
      const created = await createConnection(manager, projectId, definition(kind));
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", { status: 200 }));
      expect(await testConnection(manager, projectId, created.connectionId ?? "")).toMatchObject({
        status: "ready",
      });
      const [called] = spy.mock.calls[0] ?? [];
      expect(typeof called === "string" ? called : "").toBe(`${base}${path}`);
      spy.mockRestore();
    }
  });
  it("records a code for a key that is refused, a provider that asks for fewer requests and one that fails", async () => {
    const connectionId = await withProvider("openai");
    const outcome = async (status: number | undefined) => {
      provider.behaviour = status === undefined ? {} : { status };
      const answer = await testConnection(manager, projectId, connectionId);
      expect(JSON.stringify(answer)).not.toContain(key);
      return answer;
    };
    expect(await outcome(401)).toMatchObject({ status: "degraded", lastErrorCode: "auth_failed" });
    expect(await outcome(403)).toMatchObject({ lastErrorCode: "auth_failed" });
    expect(await outcome(429)).toMatchObject({ lastErrorCode: "rate_limited" });
    expect(await outcome(500)).toMatchObject({ lastErrorCode: "provider_error" });
    expect(await outcome(undefined)).toMatchObject({ status: "ready", lastErrorCode: null });
  });
  it("does not follow a redirect, which would take the key to another host", async () => {
    const connectionId = await withProvider("anthropic");
    const elsewhere = await startFakeProvider(key);
    try {
      provider.behaviour = { status: 302, location: `${elsewhere.url}/stolen` };
      expect(await testConnection(manager, projectId, connectionId)).toMatchObject({
        status: "degraded",
        lastErrorCode: "provider_error",
      });
      expect(provider.requests).toHaveLength(1);
      expect(elsewhere.requests).toHaveLength(0);
    } finally {
      await elsewhere.close();
    }
  });
  it("checks the host of another address again on every test, and reports a provider that is not there", async () => {
    vi.stubEnv("DEV_BOOTSTRAP", "false");
    dns.table.set("gateway.example.test", ["93.184.216.34"]);
    const created = await createConnection(
      manager,
      projectId,
      definition("openai", { endpoint: "https://gateway.example.test" }),
    );
    // The name has come to point at the machine since the connection was saved.
    dns.table.set("gateway.example.test", ["127.0.0.1"]);
    expect(await testConnection(manager, projectId, created.connectionId ?? "")).toMatchObject({
      status: "degraded",
      lastErrorCode: "host_refused",
    });
    vi.stubEnv("DEV_BOOTSTRAP", "true");
    const closed = await startFakeProvider(key);
    const url = closed.url;
    await closed.close();
    const gone = await createConnection(
      manager,
      projectId,
      definition("google", { endpoint: url, developmentOnly: true }),
    );
    expect(await testConnection(manager, projectId, gone.connectionId ?? "")).toMatchObject({
      status: "degraded",
      lastErrorCode: "connect_failed",
    });
  });
  it("maps the answers of a provider to codes that name no host or key", () => {
    const status = (providerStatus: number) => failureCode({ providerStatus });
    expect(status(401)).toBe("auth_failed");
    expect(status(403)).toBe("auth_failed");
    expect(status(429)).toBe("rate_limited");
    expect(status(404)).toBe("provider_error");
    expect(status(503)).toBe("provider_error");
    expect(failureCode({ providerStatus: "401" })).not.toBe("auth_failed");
  });
});
