import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Names resolve through this table: an unknown name resolves to a public address.
vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
}));
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ZodError } from "zod";
import { db, sqlClient } from "../src/server/db";
import { audit, connections, projects } from "../src/server/db/schema";
import { createConnection, listConnections, testConnection } from "../src/server/connections";
import type { Principal } from "../src/domain/permissions";
// The connections that are sources of knowledge: what a definition has to hold, that a secret is
// never shown, and what a test of each kind asks of its source.
const projectId = randomUUID();
const manager: Principal = {
  id: `manager-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [
    {
      projectId,
      actions: [
        "project.read",
        "integration.manage",
        "config.read",
        "config.write",
        "config.approve",
      ],
    },
  ],
};
const token = `ghp-${randomUUID()}`;
interface Seen {
  url: string;
  headers: IncomingMessage["headers"];
}
const seen: Seen[] = [];
let status = 200;
let server: Server;
let base = "";
const github = (extra: Record<string, unknown> = {}) => ({
  kind: "github",
  direction: "knowledge",
  name: "Repositories",
  config: { repositories: ["acme/app", "acme/docs"] },
  secret: { token },
  ...extra,
});
const docs = (extra: Record<string, unknown> = {}) => ({
  kind: "docs",
  direction: "knowledge",
  name: "Guide",
  config: { pages: [{ title: "Guide", url: "https://docs.example.test/guide" }] },
  ...extra,
});
const context = (extra: Record<string, unknown> = {}) => ({
  kind: "context",
  direction: "knowledge",
  name: "Customers",
  config: { endpoint: "https://crm.example.test/customers" },
  secret: { apiKey: `key-${randomUUID()}` },
  ...extra,
});
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  server = createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    response.writeHead(
      status,
      status === 302 ? { location: `${base}/elsewhere` } : { "content-type": "application/json" },
    );
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  await db()
    .insert(projects)
    .values({ id: projectId, name: "Sources", slug: `sources-${projectId}` });
}, 60_000);
beforeEach(async () => {
  vi.stubEnv("DEV_BOOTSTRAP", "false");
  await db().delete(connections).where(eq(connections.projectId, projectId));
  seen.length = 0;
  status = 200;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db().delete(connections).where(eq(connections.projectId, projectId));
  await db()
    .delete(audit)
    .where(inArray(audit.projectId, [projectId]));
  await db().delete(projects).where(eq(projects.id, projectId));
  await new Promise((resolve) => server.close(resolve));
  await sqlClient().end();
});
const refused = async (body: unknown, pointer: string) => {
  const error = await createConnection(manager, projectId, body).catch((e: unknown) => e);
  expect(error, JSON.stringify(body)).toBeInstanceOf(ZodError);
  expect(JSON.stringify((error as ZodError).issues.map((issue) => issue.path))).toContain(pointer);
};
describe("defining a source of knowledge", () => {
  it("accepts each kind, and never shows a secret", async () => {
    for (const body of [github(), docs(), docs({ secret: { token: "doc-token" } }), context()])
      expect((await createConnection(manager, projectId, body)).outcome).toBe("applied");
    const listed = await listConnections(manager, projectId);
    expect(listed.map((row) => `${row.kind}:${row.direction}`).sort()).toEqual([
      "context:knowledge",
      "docs:knowledge",
      "docs:knowledge",
      "github:knowledge",
    ]);
    const text = JSON.stringify(listed);
    for (const hidden of [token, "doc-token", "key-"]) expect(text).not.toContain(hidden);
  });
  it("checks the fields of each kind and the addresses it reaches", async () => {
    await refused(github({ config: { repositories: ["not a repository"] } }), "repositories");
    await refused(github({ config: { repositories: [] } }), "repositories");
    await refused(
      github({
        config: { repositories: Array.from({ length: 21 }, (_, i) => `acme/r${String(i)}`) },
      }),
      "repositories",
    );
    await refused(github({ secret: undefined }), "secret");
    await refused(
      github({ config: { repositories: ["a/b"], endpoint: "http://ghe.example.test/api" } }),
      "endpoint",
    );
    await refused(
      github({ config: { repositories: ["a/b"], endpoint: "https://127.0.0.1/api" } }),
      "endpoint",
    );
    await refused(docs({ config: { pages: [] } }), "pages");
    await refused(
      docs({ config: { pages: [{ title: "A", url: "http://docs.example.test/a" }] } }),
      "pages",
    );
    await refused(
      docs({
        config: {
          pages: [
            { title: "A", url: "https://docs.example.test/a" },
            { title: "B", url: "https://169.254.169.254/b" },
          ],
        },
      }),
      '1,"url"',
    );
    await refused(context({ config: { endpoint: "http://crm.example.test/c" } }), "endpoint");
    await refused(context({ config: { endpoint: "https://localhost/c" } }), "endpoint");
    await refused(context({ secret: undefined }), "secret");
    await refused({ kind: "gitlab", direction: "knowledge", name: "x", config: {} }, "kind");
    await refused(
      github({ config: { repositories: ["a/b"], developmentOnly: true } }),
      "developmentOnly",
    );
    expect(await listConnections(manager, projectId)).toEqual([]);
  });
});
describe("testing a source of knowledge", () => {
  async function created(body: unknown) {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_BOOTSTRAP", "true");
    const result = await createConnection(manager, projectId, body);
    vi.stubEnv("DEV_BOOTSTRAP", "false");
    return result.connectionId ?? "";
  }
  it("asks each repository, with the key in a header, and records what came of it", async () => {
    const id = await created(
      github({
        config: { repositories: ["acme/app", "acme/docs"], endpoint: base, developmentOnly: true },
      }),
    );
    expect(await testConnection(manager, projectId, id)).toMatchObject({
      status: "ready",
      lastErrorCode: null,
    });
    expect(seen.map((entry) => entry.url)).toEqual(["/repos/acme/app", "/repos/acme/docs"]);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${token}`);
    for (const [answer, code] of [
      [401, "auth_failed"],
      [403, "auth_failed"],
      [429, "rate_limited"],
      [500, "provider_error"],
      [404, "provider_error"],
    ] as const) {
      status = answer;
      expect(await testConnection(manager, projectId, id)).toMatchObject({
        status: "degraded",
        lastErrorCode: code,
      });
    }
  });
  it("does not follow a redirect with the key", async () => {
    const id = await created(
      github({ config: { repositories: ["acme/app"], endpoint: base, developmentOnly: true } }),
    );
    status = 302;
    expect(await testConnection(manager, projectId, id)).toMatchObject({
      status: "degraded",
      lastErrorCode: "provider_error",
    });
    expect(seen).toHaveLength(1);
  });
  it("reads a page of the documentation, with the token when there is one", async () => {
    const id = await created(
      docs({
        config: { pages: [{ title: "Guide", url: `${base}/guide` }], developmentOnly: true },
        secret: { token: "doc-token" },
      }),
    );
    expect(await testConnection(manager, projectId, id)).toMatchObject({ status: "ready" });
    expect(seen[0]?.headers.authorization).toBe("Bearer doc-token");
    const open = await created(
      docs({
        name: "Open",
        config: { pages: [{ title: "Guide", url: `${base}/open` }], developmentOnly: true },
      }),
    );
    await testConnection(manager, projectId, open);
    expect(seen.at(-1)?.headers.authorization).toBeUndefined();
    status = 404;
    expect(await testConnection(manager, projectId, id)).toMatchObject({
      status: "degraded",
      lastErrorCode: "provider_error",
    });
  });
  it("reaches the customer system without asking about a customer", async () => {
    const id = await created(
      context({ config: { endpoint: `${base}/customers`, developmentOnly: true } }),
    );
    // The system answers a request without a customer with an error of the request: it is there.
    for (const answer of [200, 400, 404, 422]) {
      status = answer;
      expect(await testConnection(manager, projectId, id)).toMatchObject({ status: "ready" });
    }
    expect(seen.every((entry) => entry.url === "/customers")).toBe(true);
    for (const [answer, code] of [
      [401, "auth_failed"],
      [500, "provider_error"],
    ] as const) {
      status = answer;
      expect(await testConnection(manager, projectId, id)).toMatchObject({
        status: "degraded",
        lastErrorCode: code,
      });
    }
  });
  it("refuses an address that has come to point somewhere that is not allowed", async () => {
    const id = await created(context());
    await db()
      .update(connections)
      .set({ config: { endpoint: "https://127.0.0.1/c" } })
      .where(eq(connections.id, id));
    expect(await testConnection(manager, projectId, id)).toMatchObject({
      status: "degraded",
      lastErrorCode: "host_refused",
    });
    expect(seen).toHaveLength(0);
  });
});
