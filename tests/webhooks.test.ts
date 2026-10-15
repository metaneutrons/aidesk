import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ZodError } from "zod";
// Names resolve through this table; an unknown name is a public address.
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
import { db, sqlClient } from "../src/server/db";
import {
  agents,
  audit,
  configChanges,
  connections,
  ingress,
  jobs,
  messages,
  projects,
  tickets,
  webhookDeliveries,
  webhooks,
} from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import { decideConfigChange, getConfig, putConfig } from "../src/server/configuration";
import { assignTicket, getTicket, reply, setTicketStatus } from "../src/server/operations";
import {
  applyWebhookPayload,
  createWebhook,
  disableWebhook,
  listWebhookDeliveries,
  listWebhooks,
  pingWebhook,
  updateWebhook,
} from "../src/server/webhooks";
import { backoffSeconds, maxAttempts, runWebhooks } from "../src/worker/webhooks";
import { initializeStorage } from "../src/server/storage";
import { signWebhook, verifyWebhook } from "../src/domain/webhooks";
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
  "ticket.read",
  "ticket.resolve",
  "ticket.reply",
  "ticket.assign",
  "integration.manage",
  "config.read",
  "config.write",
  "config.approve",
]);
const agent = person("agent", "agent", [
  "project.read",
  "ticket.read",
  "ticket.reply",
  "integration.manage",
  "config.read",
  "config.write",
]);
const plain = person("plain", "human", ["project.read", "ticket.read"]);
const secret = `whsec_${randomUUID()}`;
interface Received {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
let server: Server;
let base = "";
const received: Received[] = [];
let respond: (path: string) => { status: number; location?: string } = () => ({ status: 200 });
const body = (extra: Record<string, unknown> = {}) => ({
  name: "Receiver",
  url: `${base}/hook`,
  events: [
    "ticket.created",
    "message.received",
    "ticket.status_changed",
    "draft.created",
    "ticket.assigned",
    "change.proposed",
  ],
  secret,
  developmentOnly: true,
  ...extra,
});
async function reset() {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(webhooks).where(eq(webhooks.projectId, projectId));
  await db().delete(configChanges).where(eq(configChanges.projectId, projectId));
  await db()
    .update(projects)
    .set({ settings: {}, configVersion: 1 })
    .where(eq(projects.id, projectId));
  received.length = 0;
  respond = () => ({ status: 200 });
  dns.table.clear();
}
const dueNow = () =>
  db()
    .update(jobs)
    .set({ runAfter: new Date(0) })
    .where(and(eq(jobs.projectId, projectId), eq(jobs.type, "webhook.deliver")));
const drain = async () => {
  while (await runWebhooks({ projectId }));
};
const webhookJobs = () =>
  db()
    .select()
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), eq(jobs.type, "webhook.deliver")));
async function ticket() {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Hook",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      pendingSince: new Date(),
    })
    .returning();
  return row?.id ?? "";
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values({ id: projectId, name: "Hooks", slug: `hooks-${projectId}` });
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const answer = respond(request.url ?? "");
      response.statusCode = answer.status;
      if (answer.location) response.setHeader("location", answer.location);
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEV_BOOTSTRAP", "true");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => server.close(resolve));
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(ingress).where(eq(ingress.projectId, projectId));
  const left = await db()
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.projectId, projectId));
  if (left.length)
    await db()
      .delete(messages)
      .where(
        inArray(
          messages.ticketId,
          left.map((row) => row.id),
        ),
      );
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db()
    .delete(audit)
    .where(inArray(audit.projectId, [projectId]));
  await db().delete(projects).where(eq(projects.id, projectId));
  await sqlClient().end();
});
afterEach(() => {
  dns.table.clear();
});
describe("signing a delivery", () => {
  it("is checked by the receiver against the secret, the timestamp and the exact body", () => {
    const text = JSON.stringify({ id: "1", type: "ping" });
    const now = Math.floor(Date.now() / 1000);
    const header = signWebhook(secret, now, text);
    expect(header).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyWebhook(secret, header, now, text)).toBe(true);
    expect(verifyWebhook(secret, header, now, `${text} `)).toBe(false);
    expect(verifyWebhook(`${secret}x`, header, now, text)).toBe(false);
    expect(verifyWebhook(secret, header, now + 1, text)).toBe(false);
    expect(verifyWebhook(secret, "v1=00", now, text)).toBe(false);
    // A captured request is useless later.
    const old = now - 3600;
    expect(verifyWebhook(secret, signWebhook(secret, old, text), old, text)).toBe(false);
    expect(verifyWebhook(secret, signWebhook(secret, old, text), old, text, { now: old })).toBe(
      true,
    );
  });
});
describe("defining a webhook", () => {
  it("applies for a person, lists it without the secret and keeps the secret sealed", async () => {
    await reset();
    const result = await createWebhook(manager, projectId, body());
    expect(result).toMatchObject({ outcome: "applied", version: 1, validated: false });
    const [row] = await db().select().from(webhooks).where(eq(webhooks.projectId, projectId));
    expect(row?.secretCiphertext).toMatch(/^v1:/);
    expect(row?.secretCiphertext).not.toContain(secret);
    const listed = await listWebhooks(manager, projectId);
    expect(listed[0]).toMatchObject({
      name: "Receiver",
      secretSet: true,
      status: "active",
      lastDelivery: null,
    });
    const everything = JSON.stringify([
      listed,
      result,
      await db().select().from(audit).where(eq(audit.projectId, projectId)),
      await db().select().from(configChanges).where(eq(configChanges.projectId, projectId)),
    ]);
    expect(everything).not.toContain(secret);
  });
  it("refuses an endpoint a production stack may not use, naming the field", async () => {
    await reset();
    vi.stubEnv("DEV_BOOTSTRAP", "false");
    const issue = async (changes: Record<string, unknown>) => {
      const error = await createWebhook(
        manager,
        projectId,
        body({ developmentOnly: false, url: "https://hooks.example.test/in", ...changes }),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ZodError);
      return (error as ZodError).issues.map((issue) => `${issue.path.join("/")}: ${issue.message}`);
    };
    expect(await issue({ url: "http://hooks.example.test/in" })).toEqual([
      "url: HTTPS is required",
    ]);
    expect(await issue({ url: "https://user:pass@hooks.example.test/in" })).toEqual([
      "url: Credentials do not belong in the address",
    ]);
    dns.table.set("inner.example.test", ["127.0.0.1"]);
    expect(await issue({ url: "https://inner.example.test/in" })).toEqual([
      "url: This host is not allowed",
    ]);
    expect(await issue({ url: "https://169.254.169.254/in" })).toEqual([
      "url: This host is not allowed",
    ]);
    dns.table.set("gone.example.test", []);
    expect(await issue({ url: "https://gone.example.test/in" })).toEqual([
      "url: This host does not resolve",
    ]);
    expect(await issue({ developmentOnly: true })).toEqual([
      "developmentOnly: Only a development stack accepts this",
    ]);
    expect((await issue({ secret: "short" })).join()).toContain("secret");
    expect((await issue({ events: [] })).join()).toContain("events");
    expect((await issue({ events: ["ticket.deleted"] })).join()).toContain("events");
    expect(await listWebhooks(manager, projectId)).toEqual([]);
    vi.stubEnv("DEV_BOOTSTRAP", "true");
    // A public HTTPS endpoint is accepted.
    expect(
      (
        await createWebhook(
          manager,
          projectId,
          body({ developmentOnly: false, url: "https://hooks.example.test/in" }),
        )
      ).outcome,
    ).toBe("applied");
  });
  it("needs integration.manage, validates without writing and repeats as one", async () => {
    await reset();
    await expect(createWebhook(plain, projectId, body())).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(listWebhooks(plain, projectId)).rejects.toMatchObject({ code: "not_found" });
    expect(await createWebhook(manager, projectId, body(), { validate: true })).toMatchObject({
      validated: true,
      outcome: "applied",
      target: null,
    });
    expect(await listWebhooks(manager, projectId)).toEqual([]);
    const key = randomUUID();
    const first = await createWebhook(manager, projectId, body({ idempotencyKey: key }));
    expect(await createWebhook(manager, projectId, body({ idempotencyKey: key }))).toEqual(first);
    expect(await listWebhooks(manager, projectId)).toHaveLength(1);
  });
  it("is changed with the version that was read, a new secret replaces the old, and disabling is a version", async () => {
    await reset();
    const id = (await createWebhook(manager, projectId, body())).target ?? "";
    const [before] = await db().select().from(webhooks).where(eq(webhooks.id, id));
    expect(
      await updateWebhook(manager, projectId, id, {
        expectedVersion: 1,
        name: "Renamed",
        events: ["ticket.created"],
      }),
    ).toMatchObject({ outcome: "applied", version: 2 });
    await expect(
      updateWebhook(manager, projectId, id, { expectedVersion: 1, name: "Late" }),
    ).rejects.toMatchObject({ code: "stale_version" });
    const replaced = await updateWebhook(manager, projectId, id, {
      expectedVersion: 2,
      secret: `${secret}-new`,
    });
    expect(replaced.diff).toEqual([{ pointer: "/secret", from: "set", to: "replaced" }]);
    const [after] = await db().select().from(webhooks).where(eq(webhooks.id, id));
    expect(after?.secretCiphertext).not.toBe(before?.secretCiphertext);
    expect(JSON.stringify(replaced)).not.toContain(`${secret}-new`);
    expect(await updateWebhook(manager, projectId, id, { expectedVersion: 3 })).toMatchObject({
      outcome: "unchanged",
    });
    expect(await disableWebhook(manager, projectId, id, { expectedVersion: 3 })).toMatchObject({
      outcome: "applied",
      version: 4,
    });
    expect((await listWebhooks(manager, projectId))[0]?.status).toBe("disabled");
    await expect(pingWebhook(manager, projectId, id)).rejects.toMatchObject({ code: "conflict" });
  });
  it("is proposed by an agent under the review policy with the secret sealed, and a person decides", async () => {
    await reset();
    const proposed = await createWebhook(agent, projectId, body());
    expect(proposed).toMatchObject({ outcome: "proposed", target: null });
    const [stored] = await db()
      .select()
      .from(configChanges)
      .where(eq(configChanges.id, proposed.changeId ?? ""));
    expect(stored).toMatchObject({ kind: "webhook.create", status: "pending" });
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(await listWebhooks(manager, projectId)).toEqual([]);
    await expect(
      decideConfigChange(agent, proposed.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await decideConfigChange(manager, proposed.changeId ?? "", { decision: "approve" }),
    ).toMatchObject({ status: "applied", version: 1 });
    const [hook] = await listWebhooks(manager, projectId);
    expect(hook).toMatchObject({ name: "Receiver", status: "active" });
    const stale = await updateWebhook(agent, projectId, hook?.id ?? "", {
      expectedVersion: 1,
      name: "By agent",
    });
    await updateWebhook(manager, projectId, hook?.id ?? "", {
      expectedVersion: 1,
      name: "By person",
    });
    await expect(
      decideConfigChange(manager, stale.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "stale_version" });
    expect((await listWebhooks(manager, projectId))[0]?.name).toBe("By person");
  });
});
describe("events", () => {
  const subscribers = async (types: string[]) =>
    (await webhookJobs()).filter((job) =>
      types.includes((job.payload.event as { type: string }).type),
    );
  it("are queued for the webhooks that subscribed, with identifiers and facts and no content", async () => {
    await reset();
    await createWebhook(manager, projectId, body({ name: "All" }));
    await createWebhook(
      manager,
      projectId,
      body({ name: "Created only", events: ["ticket.created"] }),
    );
    const disabled = (await createWebhook(manager, projectId, body({ name: "Off" }))).target ?? "";
    await disableWebhook(manager, projectId, disabled, { expectedVersion: 1 });
    // A new inbound mail opens a ticket and adds a message.
    const raw = Buffer.from(
      [
        "From: Kim <kim@example.test>",
        "To: support@example.test",
        `Subject: Event ${randomUUID()}`,
        `Message-ID: <${randomUUID()}@example.test>`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "A secret question",
        "",
      ].join("\r\n"),
    );
    const { ingressId } = await acceptInbound({
      projectId,
      connectionId: null,
      externalKey: `test:${randomUUID()}`,
      raw,
    });
    await processIngress(ingressId);
    const jobsNow = await webhookJobs();
    const types = jobsNow.map((job) => (job.payload.event as { type: string }).type).sort();
    expect(types).toEqual(["message.received", "ticket.created", "ticket.created"]);
    const created = jobsNow.find(
      (job) => (job.payload.event as { type: string }).type === "ticket.created",
    );
    expect(created?.payload.event).toMatchObject({ projectId, data: { language: "en" } });
    expect(JSON.stringify(jobsNow)).not.toContain("A secret question");
    expect(JSON.stringify(jobsNow)).not.toContain("kim@example.test");
    expect(jobsNow.every((job) => job.payload.webhookId !== disabled)).toBe(true);
    // Every event has its own id and one job per subscriber.
    expect(new Set(jobsNow.map((job) => job.dedupKey)).size).toBe(3);
  });
  it("announce a status change, a draft and a proposal", async () => {
    await reset();
    await createWebhook(manager, projectId, body());
    const id = await ticket();
    const revision = (await getTicket(manager, id)).ticket.revision;
    await setTicketStatus(manager, id, { status: "resolved", expectedRevision: revision });
    expect(await subscribers(["ticket.status_changed"])).toHaveLength(1);
    expect((await subscribers(["ticket.status_changed"]))[0]?.payload.event).toMatchObject({
      data: { ticketId: id, from: "open", to: "resolved" },
    });
    // The same status again changes nothing and announces nothing.
    await setTicketStatus(manager, id, { status: "resolved", expectedRevision: revision + 1 });
    expect(await subscribers(["ticket.status_changed"])).toHaveLength(1);
    const open = await ticket();
    const [outgoing] = await db()
      .insert(connections)
      .values({
        projectId,
        kind: "smtp",
        direction: "outbound",
        name: "Out",
        status: "ready",
        config: {},
      })
      .returning({ id: connections.id });
    await db()
      .update(projects)
      .set({ settings: { outboundConnectionId: outgoing?.id } })
      .where(eq(projects.id, projectId));
    await reply(agent, open, {
      markdown: "Draft",
      internal: false,
      expectedRevision: (await getTicket(manager, open)).ticket.revision,
      idempotencyKey: randomUUID(),
      language: "en",
      resolve: false,
    });
    expect(await subscribers(["draft.created"])).toHaveLength(1);
    const config = await getConfig(manager, projectId);
    await putConfig(agent, projectId, {
      config: { ...config.config, name: "Proposed" },
      expectedVersion: config.version,
    });
    await createWebhook(agent, projectId, body({ name: "Second" }));
    expect(
      (await subscribers(["change.proposed"]))
        .map((job) => (job.payload.event as { data: { kind: string } }).data.kind)
        .sort(),
    ).toEqual(["config", "webhook.create"]);
  });
});
describe("the event ticket.assigned", () => {
  it("is queued when the assignee changes, with identifiers only, and not when it stays", async () => {
    await reset();
    await createWebhook(manager, projectId, body({ events: ["ticket.assigned"] }));
    const id = await ticket();
    const [held] = await db()
      .insert(agents)
      .values({
        name: "Assignee",
        projectId,
        actions: ["ticket.read"],
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: agents.id });
    const agentId = held?.id ?? "";
    await assignTicket(manager, id, { userId: null, agentId });
    const first = await webhookJobs();
    expect(first).toHaveLength(1);
    expect((first[0]?.payload.event as { data: unknown }).data).toEqual({
      ticketId: id,
      number: (await getTicket(manager, id)).ticket.number,
      assigneeUserId: null,
      assigneeAgentId: agentId,
      previousUserId: null,
      previousAgentId: null,
      actorId: manager.id,
    });
    // The same assignee again changes nothing and announces nothing.
    await assignTicket(manager, id, { userId: null, agentId });
    expect(await webhookJobs()).toHaveLength(1);
    await assignTicket(manager, id, { userId: null, agentId: null });
    const all = await webhookJobs();
    expect(all).toHaveLength(2);
    expect(
      all.map((job) => (job.payload.event as { data: { previousAgentId: string | null } }).data),
    ).toContainEqual(expect.objectContaining({ previousAgentId: agentId, assigneeAgentId: null }));
    await db().delete(agents).where(eq(agents.id, agentId));
  });
});
describe("delivery", () => {
  it("posts the event signed, records the attempt and finishes the job", async () => {
    await reset();
    const id = (await createWebhook(manager, projectId, body())).target ?? "";
    const queued = await pingWebhook(manager, projectId, id);
    await drain();
    expect(received).toHaveLength(1);
    const [call] = received;
    expect(call?.url).toBe("/hook");
    const event = JSON.parse(call?.body ?? "{}") as { id: string; type: string; projectId: string };
    expect(event).toMatchObject({ id: queued.eventId, type: "ping", projectId });
    expect(call?.headers).toMatchObject({
      "content-type": "application/json",
      "x-aidesk-event": "ping",
      "x-aidesk-event-id": queued.eventId,
      "x-aidesk-delivery-attempt": "1",
    });
    const stamp = Number(call?.headers["x-aidesk-timestamp"]);
    expect(
      verifyWebhook(secret, String(call?.headers["x-aidesk-signature"]), stamp, call?.body ?? ""),
    ).toBe(true);
    expect(
      verifyWebhook(
        `${secret}x`,
        String(call?.headers["x-aidesk-signature"]),
        stamp,
        call?.body ?? "",
      ),
    ).toBe(false);
    expect((await webhookJobs())[0]).toMatchObject({ status: "succeeded", attempts: 1 });
    const log = await listWebhookDeliveries(manager, projectId, id);
    expect(log).toEqual([
      expect.objectContaining({
        outcome: "succeeded",
        responseStatus: 200,
        code: null,
        attempt: 1,
        event: "ping",
        eventId: queued.eventId,
      }),
    ]);
    expect((await listWebhooks(manager, projectId))[0]?.lastDelivery).toMatchObject({
      outcome: "succeeded",
      event: "ping",
    });
  });
  it("tries again after a pause when the endpoint fails and stops when it recovers", async () => {
    await reset();
    const id = (await createWebhook(manager, projectId, body())).target ?? "";
    await pingWebhook(manager, projectId, id);
    respond = () => ({ status: 503 });
    await drain();
    expect(received).toHaveLength(1);
    let [job] = await webhookJobs();
    expect(job).toMatchObject({ status: "queued", attempts: 1, lastErrorCode: "http_503" });
    // Not due yet: nothing is sent before the pause is over.
    expect(await runWebhooks({ projectId })).toBe(false);
    expect((job?.runAfter.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      (backoffSeconds[0] ?? 0) * 1000 - 5000,
    );
    respond = () => ({ status: 200 });
    await dueNow();
    await drain();
    [job] = await webhookJobs();
    expect(job).toMatchObject({ status: "succeeded", attempts: 2, lastErrorCode: null });
    expect(received.map((entry) => entry.headers["x-aidesk-delivery-attempt"])).toEqual(["1", "2"]);
    expect(received[0]?.headers["x-aidesk-event-id"]).toBe(
      received[1]?.headers["x-aidesk-event-id"],
    );
    expect(
      (await listWebhookDeliveries(manager, projectId, id)).map((entry) => entry.outcome).sort(),
    ).toEqual(["retry", "succeeded"]);
  });
  it("gives up after the last attempt and leaves the job in review", async () => {
    await reset();
    const id = (await createWebhook(manager, projectId, body())).target ?? "";
    await pingWebhook(manager, projectId, id);
    respond = () => ({ status: 500 });
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await dueNow();
      await drain();
    }
    expect(received).toHaveLength(maxAttempts);
    expect((await webhookJobs())[0]).toMatchObject({
      status: "review",
      attempts: maxAttempts,
      lastErrorCode: "http_500",
    });
    const log = await listWebhookDeliveries(manager, projectId, id);
    expect(log.filter((entry) => entry.outcome === "failed")).toHaveLength(1);
    expect(log.filter((entry) => entry.outcome === "retry")).toHaveLength(maxAttempts - 1);
    // Nothing more is sent.
    await dueNow();
    await drain();
    expect(received).toHaveLength(maxAttempts);
  });
  it("does not follow a redirect", async () => {
    await reset();
    const id = (await createWebhook(manager, projectId, body())).target ?? "";
    await pingWebhook(manager, projectId, id);
    respond = (path) =>
      path === "/hook" ? { status: 302, location: "/elsewhere" } : { status: 200 };
    await drain();
    expect(received.map((entry) => entry.url)).toEqual(["/hook"]);
    expect((await listWebhookDeliveries(manager, projectId, id))[0]).toMatchObject({
      code: "redirect",
      responseStatus: 302,
      outcome: "retry",
    });
  });
  it("reports a connection that is refused", async () => {
    await reset();
    // A port that was free a moment ago and has nobody listening.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const id =
      (
        await createWebhook(
          manager,
          projectId,
          body({ url: `http://127.0.0.1:${String(port)}/hook` }),
        )
      ).target ?? "";
    await pingWebhook(manager, projectId, id);
    await drain();
    expect((await listWebhookDeliveries(manager, projectId, id))[0]).toMatchObject({
      code: "connect_failed",
      responseStatus: null,
      outcome: "retry",
    });
  });
  it("refuses a host that now points at the machine, and a webhook that was disabled meanwhile", async () => {
    await reset();
    vi.stubEnv("DEV_BOOTSTRAP", "false");
    dns.table.set("late.example.test", ["93.184.216.34"]);
    const id =
      (
        await createWebhook(
          manager,
          projectId,
          body({ developmentOnly: false, url: "https://late.example.test/hook" }),
        )
      ).target ?? "";
    await pingWebhook(manager, projectId, id);
    dns.table.set("late.example.test", ["127.0.0.1"]);
    await drain();
    expect(received).toHaveLength(0);
    expect((await listWebhookDeliveries(manager, projectId, id))[0]).toMatchObject({
      code: "host_refused",
      outcome: "failed",
    });
    expect((await webhookJobs())[0]).toMatchObject({
      status: "review",
      lastErrorCode: "host_refused",
    });
    vi.stubEnv("DEV_BOOTSTRAP", "true");
    await reset();
    const other = (await createWebhook(manager, projectId, body())).target ?? "";
    await pingWebhook(manager, projectId, other);
    await db().update(webhooks).set({ status: "disabled" }).where(eq(webhooks.id, other));
    await drain();
    expect(received).toHaveLength(0);
    expect((await listWebhookDeliveries(manager, projectId, other))[0]).toMatchObject({
      code: "webhook_disabled",
      outcome: "failed",
    });
  });
  it("delivers an event of a real change end to end", async () => {
    await reset();
    await createWebhook(manager, projectId, body({ events: ["ticket.status_changed"] }));
    const id = await ticket();
    await setTicketStatus(manager, id, {
      status: "resolved",
      expectedRevision: (await getTicket(manager, id)).ticket.revision,
    });
    await drain();
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]?.body ?? "{}")).toMatchObject({
      type: "ticket.status_changed",
      data: { ticketId: id, to: "resolved" },
    });
    expect(await db().select().from(messages).where(eq(messages.ticketId, id))).toEqual([]);
    expect(
      (
        await db()
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.projectId, projectId))
      ).length,
    ).toBe(1);
  });
});
describe("webhooks that do not exist, and partial changes", () => {
  it("answers not_found, and changes only what is named", async () => {
    await reset();
    const ghost = randomUUID();
    // A project that does not exist, for someone who holds the right on it.
    const stranger: Principal = {
      ...manager,
      grants: [{ projectId: ghost, actions: ["integration.manage"] }],
    };
    await expect(createWebhook(stranger, ghost, body())).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(listWebhookDeliveries(manager, projectId, ghost)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      updateWebhook(manager, projectId, ghost, { expectedVersion: 1, name: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      disableWebhook(manager, projectId, ghost, { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(pingWebhook(manager, projectId, ghost)).rejects.toMatchObject({
      code: "not_found",
    });
    const id = (await createWebhook(manager, projectId, body())).target ?? "";
    const moved = await updateWebhook(manager, projectId, id, {
      expectedVersion: 1,
      url: `${base}/other`,
      developmentOnly: true,
    });
    expect(moved.diff).toEqual([{ pointer: "/url", from: `${base}/hook`, to: `${base}/other` }]);
    const [row] = await db().select().from(webhooks).where(eq(webhooks.id, id));
    expect(row).toMatchObject({ url: `${base}/other`, name: "Receiver", status: "active" });
    expect(await disableWebhook(manager, projectId, id, { expectedVersion: 2 })).toMatchObject({
      outcome: "applied",
    });
    expect(await disableWebhook(manager, projectId, id, { expectedVersion: 3 })).toMatchObject({
      outcome: "unchanged",
    });
  });
});
describe("a job that is not a delivery", () => {
  it("is recorded as failed without sending anything", async () => {
    await reset();
    const id = (await createWebhook(manager, projectId, body())).target ?? "";
    await db()
      .insert(jobs)
      .values({
        projectId,
        type: "webhook.deliver",
        dedupKey: `broken:${randomUUID()}`,
        payload: { webhookId: id, event: "not an event" },
      });
    await drain();
    expect(received).toHaveLength(0);
    expect((await webhookJobs())[0]).toMatchObject({
      status: "review",
      lastErrorCode: "webhook_disabled",
    });
  });
});
describe("applying a stored change", () => {
  it("refuses a change without a target or for a webhook that is gone", async () => {
    await reset();
    await expect(
      db().transaction((tx) =>
        applyWebhookPayload(tx, projectId, "webhook.update", null, {}, "test", []),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db().transaction((tx) =>
        applyWebhookPayload(tx, projectId, "webhook.disable", randomUUID(), {}, "test", []),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
