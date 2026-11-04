import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit } from "../src/server/db/schema";
import { resetEnv } from "../src/server/env";
import {
  applyUpdate,
  checkUpdates,
  setUpdateSchedule,
  updateStatus,
  updatesOut,
} from "../src/server/updates";
import type { Principal } from "../src/domain/permissions";
// The way from the settings page to the updater: what the owner may ask, what is passed on, what is written down, and what
// is said when the updater is not there, does not know the token or answers something else. The updater is a server of
// this process that answers like the control API of deploy/updater, so the requests that reach it are the real ones.
const run = randomUUID().slice(0, 8);
const ownerId = `updates-owner-${run}`;
const owner: Principal = { id: ownerId, kind: "human", active: true, owner: true, grants: [] };
const token = `updater-token-${run}-`.padEnd(40, "t");
const status = (changes: Record<string, unknown> = {}) => ({
  state: "available",
  currentVersion: "0.1.0",
  availableVersion: "v0.2.0",
  updateAvailable: true,
  lastCheckedAt: "2026-11-03T08:00:00.000Z",
  lastUpdatedAt: null,
  lastError: null,
  releaseCheckStatus: "ok",
  releaseCheckError: null,
  releaseCheckRetryAt: null,
  updaterVersion: "0.1.0",
  updaterUpdateAvailable: true,
  updaterSelfUpdateEnabled: true,
  managedBy: null,
  updateMode: "manual",
  maintenanceTime: "02:00",
  timezone: "Europe/Berlin",
  updaterSwap: null,
  progress: null,
  ...changes,
});
interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}
let updater: Server;
let seen: Seen[] = [];
// What the updater answers to the next request, by method and path.
let answers: Record<string, (response: ServerResponse) => void> = {};
const json = (code: number, body: unknown) => (response: ServerResponse) => {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
function handle(request: IncomingMessage, response: ServerResponse) {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => (body += chunk));
  request.on("end", () => {
    seen.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
      body,
    });
    const answer = answers[`${request.method ?? ""} ${request.url ?? ""}`];
    if (answer) answer(response);
    else json(404, { error: "not_found" })(response);
  });
}
const original = {
  token: process.env.UPDATER_TOKEN,
  url: process.env.UPDATER_URL,
  coolify: process.env.COOLIFY_RESOURCE_UUID,
};
function use(values: {
  token?: string | undefined;
  url?: string | undefined;
  coolify?: string | undefined;
}) {
  for (const [name, value] of [
    ["UPDATER_TOKEN", values.token],
    ["UPDATER_URL", values.url],
    ["COOLIFY_RESOURCE_UUID", values.coolify],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  resetEnv();
}
const address = () => `http://127.0.0.1:${String((updater.address() as AddressInfo).port)}`;
const entries = (action: string) =>
  db()
    .select()
    .from(audit)
    .where(eq(audit.actorId, ownerId))
    .then((rows) => rows.filter((row) => row.action === action));
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  updater = createServer(handle);
  await new Promise<void>((resolve) => updater.listen(0, "127.0.0.1", resolve));
});
beforeEach(() => {
  seen = [];
  answers = {};
  use({ token, url: address() });
});
afterEach(() => {
  use({ token: original.token, url: original.url, coolify: original.coolify });
});
afterAll(async () => {
  await new Promise((resolve) => updater.close(resolve));
  await db().delete(audit).where(eq(audit.actorId, ownerId));
  await sqlClient().end();
});
describe("the status", () => {
  it("passes the token and shows what the updater reports, in the shape of its definition", async () => {
    answers["GET /v1/status"] = json(200, status());
    const updates = await updateStatus(owner);
    expect(updatesOut.parse(updates)).toEqual({
      availability: "ok",
      status: status(),
      managedBy: null,
    });
    expect(seen).toEqual([
      { method: "GET", url: "/v1/status", authorization: `Bearer ${token}`, body: "" },
    ]);
  });
  it("says that there is no updater when no token is set, and asks nobody", async () => {
    use({ token: undefined, url: address() });
    expect(await updateStatus(owner)).toEqual({
      availability: "not-configured",
      status: null,
      managedBy: null,
    });
    expect(await checkUpdates(owner)).toEqual({
      availability: "not-configured",
      status: null,
      managedBy: null,
    });
    expect(seen).toEqual([]);
  });
  it("says that the token is not the updater's when it answers 401", async () => {
    answers["GET /v1/status"] = json(401, { error: "unauthorized" });
    expect(await updateStatus(owner)).toEqual({
      availability: "unauthorized",
      status: null,
      managedBy: null,
    });
  });
  it("says that the updater does not answer when nothing listens, and when something else does", async () => {
    use({ token, url: "http://127.0.0.1:1" });
    expect(await updateStatus(owner)).toEqual({
      availability: "unreachable",
      status: null,
      managedBy: null,
    });
    use({ token, url: address() });
    answers["GET /v1/status"] = json(200, { hello: "another service" });
    expect(await updateStatus(owner)).toEqual({
      availability: "unreachable",
      status: null,
      managedBy: null,
    });
    answers["GET /v1/status"] = (response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html></html>");
    };
    expect(await updateStatus(owner)).toEqual({
      availability: "unreachable",
      status: null,
      managedBy: null,
    });
  });
  it("does not follow a redirect, so that the token goes to the updater and nowhere else", async () => {
    const elsewhere: Seen[] = [];
    const other = createServer((request, response) => {
      elsewhere.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body: "",
      });
      json(200, status())(response);
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const target = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}/v1/status`;
    answers["GET /v1/status"] = (response) => {
      response.writeHead(302, { location: target });
      response.end();
    };
    expect(await updateStatus(owner)).toEqual({
      availability: "unreachable",
      status: null,
      managedBy: null,
    });
    await new Promise((resolve) => other.close(resolve));
    expect(elsewhere).toEqual([]);
  });
});
describe("the check", () => {
  it("asks the updater and returns what it reports", async () => {
    answers["POST /v1/check"] = json(202, status({ state: "checking" }));
    const updates = await checkUpdates(owner);
    expect(updates.status?.state).toBe("checking");
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual(["POST /v1/check"]);
  });
  it("returns the status of an operation that is already running", async () => {
    answers["POST /v1/check"] = json(409, {
      error: "operation_in_progress",
      status: status({ state: "updating" }),
    });
    expect((await checkUpdates(owner)).status?.state).toBe("updating");
  });
});
describe("the update", () => {
  it("starts what the updater found, names no version of its own, and writes it down", async () => {
    answers["GET /v1/status"] = json(200, status());
    answers["POST /v1/apply"] = json(202, status({ state: "updating" }));
    const updates = await applyUpdate(owner);
    expect(updates.status?.state).toBe("updating");
    const apply = seen.find((entry) => entry.url === "/v1/apply");
    expect(apply).toMatchObject({ method: "POST", authorization: `Bearer ${token}`, body: "" });
    expect(await entries("updates.apply")).toMatchObject([
      { projectId: null, targetId: "workspace", detail: { from: "0.1.0", to: "v0.2.0" } },
    ]);
    // Nothing of the secret is in the entry.
    expect(JSON.stringify(await entries("updates.apply"))).not.toContain(token);
  });
  it("is refused when no release is waiting, and the updater is not asked to install", async () => {
    answers["GET /v1/status"] = json(200, status({ state: "current", updateAvailable: false }));
    await expect(applyUpdate(owner)).rejects.toMatchObject({ code: "conflict", status: 409 });
    expect(seen.some((entry) => entry.url === "/v1/apply")).toBe(false);
  });
  it("is refused while the updater checks or installs", async () => {
    for (const state of ["updating", "checking"]) {
      seen = [];
      answers["GET /v1/status"] = json(200, status({ state }));
      await expect(applyUpdate(owner)).rejects.toMatchObject({ code: "conflict" });
      expect(seen.some((entry) => entry.url === "/v1/apply")).toBe(false);
    }
  });
  it("is refused when the updater does not answer or does not know the token", async () => {
    answers["GET /v1/status"] = json(401, { error: "unauthorized" });
    await expect(applyUpdate(owner)).rejects.toMatchObject({ code: "source_unavailable" });
    use({ token, url: "http://127.0.0.1:1" });
    await expect(applyUpdate(owner)).rejects.toMatchObject({ code: "source_unavailable" });
  });
  it("is not written down when the updater did not accept it", async () => {
    answers["GET /v1/status"] = json(200, status());
    await db().delete(audit).where(eq(audit.actorId, ownerId));
    // Another operation started in between.
    answers["POST /v1/apply"] = json(409, { error: "operation_in_progress" });
    await expect(applyUpdate(owner)).rejects.toMatchObject({ code: "conflict" });
    // Something other than 202: the update did not start as asked.
    answers["POST /v1/apply"] = json(200, status());
    await expect(applyUpdate(owner)).rejects.toMatchObject({ code: "source_unavailable" });
    answers["POST /v1/apply"] = json(500, { error: "boom" });
    await expect(applyUpdate(owner)).rejects.toMatchObject({ code: "source_unavailable" });
    expect(await entries("updates.apply")).toEqual([]);
  });
  it("is refused without an updater", async () => {
    use({ token: undefined, url: address() });
    await expect(applyUpdate(owner)).rejects.toMatchObject({ code: "conflict" });
    expect(seen).toEqual([]);
  });
});
describe("the maintenance window", () => {
  const input = { mode: "automatic", maintenanceTime: "03:30", timezone: "Europe/Berlin" };
  it("passes exactly what was chosen, and writes it down", async () => {
    answers["POST /v1/config"] = json(
      200,
      status({ updateMode: "automatic", maintenanceTime: "03:30" }),
    );
    const updates = await setUpdateSchedule(owner, input);
    expect(updates.status).toMatchObject({ updateMode: "automatic", maintenanceTime: "03:30" });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual(input);
    expect(await entries("updates.schedule")).toMatchObject([{ detail: input }]);
  });
  it("refuses a time, a zone or a field that the updater would refuse, before it is asked", async () => {
    for (const bad of [
      { ...input, maintenanceTime: "24:00" },
      { ...input, maintenanceTime: "3:30" },
      { ...input, timezone: "Not/AZone" },
      { ...input, timezone: "" },
      { ...input, mode: "sometimes" },
      { ...input, extra: true },
      {},
    ])
      await expect(setUpdateSchedule(owner, bad)).rejects.toThrow();
    expect(seen).toEqual([]);
  });
  it("is refused while an operation runs, and when the updater refuses the values", async () => {
    answers["POST /v1/config"] = json(409, { error: "operation_in_progress" });
    await expect(setUpdateSchedule(owner, input)).rejects.toMatchObject({ code: "conflict" });
    answers["POST /v1/config"] = json(400, { error: "invalid_config" });
    await expect(setUpdateSchedule(owner, input)).rejects.toMatchObject({
      code: "invalid_input",
    });
    answers["POST /v1/config"] = json(500, { error: "boom" });
    await expect(setUpdateSchedule(owner, input)).rejects.toMatchObject({
      code: "source_unavailable",
    });
  });
  it("is not written down when it was not applied", async () => {
    await db().delete(audit).where(eq(audit.actorId, ownerId));
    answers["POST /v1/config"] = json(409, { error: "operation_in_progress" });
    await expect(setUpdateSchedule(owner, input)).rejects.toThrow();
    expect(await entries("updates.schedule")).toEqual([]);
  });
});
describe("a platform that deploys the installation itself", () => {
  const coolify = `coolify-app-${run}`;
  const input = { mode: "automatic", maintenanceTime: "03:30", timezone: "Europe/Berlin" };
  it("is recognised by the environment of the application, even with a token, and asks nobody", async () => {
    use({ token, url: address(), coolify });
    answers["GET /v1/status"] = json(200, status());
    const expected = { availability: "not-configured", status: null, managedBy: "coolify" };
    expect(updatesOut.parse(await updateStatus(owner))).toEqual(expected);
    expect(await checkUpdates(owner)).toEqual(expected);
    expect(seen).toEqual([]);
  });
  it("offers neither an installation nor a maintenance window", async () => {
    use({ token, url: address(), coolify });
    answers["GET /v1/status"] = json(200, status());
    await expect(applyUpdate(owner)).rejects.toMatchObject({ code: "conflict", status: 409 });
    await expect(setUpdateSchedule(owner, input)).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
    expect(seen).toEqual([]);
    expect(await entries("updates.apply")).toEqual([]);
    expect(await entries("updates.schedule")).toEqual([]);
  });
  it("is not assumed from an empty variable or from its absence", async () => {
    use({ token, url: address(), coolify: "" });
    answers["GET /v1/status"] = json(200, status());
    expect((await updateStatus(owner)).managedBy).toBeNull();
    expect(seen).toHaveLength(1);
  });
  it("is shown when the updater found it, and no installation is started then", async () => {
    answers["GET /v1/status"] = json(200, status({ managedBy: "coolify", updateAvailable: true }));
    const updates = await updateStatus(owner);
    expect(updatesOut.parse(updates)).toMatchObject({ availability: "ok", managedBy: "coolify" });
    expect(updates.status?.managedBy).toBe("coolify");
    seen = [];
    await expect(applyUpdate(owner)).rejects.toMatchObject({ code: "conflict", status: 409 });
    expect(seen.some((entry) => entry.url === "/v1/apply")).toBe(false);
  });
  it("is told to the person who is not the owner nowhere: they are refused first", async () => {
    use({ token, url: address(), coolify });
    const plain: Principal = { ...owner, id: `updates-person-${run}`, owner: false };
    await expect(updateStatus(plain)).rejects.toMatchObject({ status: 403 });
  });
  it("accepts an updater that does not report the platform yet", async () => {
    const old: Record<string, unknown> = status();
    Reflect.deleteProperty(old, "managedBy");
    answers["GET /v1/status"] = json(200, old);
    expect(await updateStatus(owner)).toMatchObject({ availability: "ok", managedBy: null });
  });
});
describe("who may ask", () => {
  const plain: Principal = { ...owner, id: `updates-person-${run}`, owner: false };
  const agent: Principal = { ...owner, id: `updates-agent-${run}`, kind: "agent" };
  const inactive: Principal = { ...owner, id: `updates-gone-${run}`, active: false };
  it("is the owner and nobody else: not a person, an agent or one who is deactivated", async () => {
    answers["GET /v1/status"] = json(200, status());
    for (const principal of [plain, agent, inactive]) {
      await expect(updateStatus(principal)).rejects.toMatchObject({ status: 403 });
      await expect(checkUpdates(principal)).rejects.toMatchObject({ status: 403 });
      await expect(applyUpdate(principal)).rejects.toMatchObject({ status: 403 });
      await expect(
        setUpdateSchedule(principal, {
          mode: "manual",
          maintenanceTime: "02:00",
          timezone: "UTC",
        }),
      ).rejects.toMatchObject({ status: 403 });
    }
    // Not even the token was sent for them.
    expect(seen).toEqual([]);
  });
});
