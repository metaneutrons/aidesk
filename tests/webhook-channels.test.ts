import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ZodError } from "zod";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  configChanges,
  jobs,
  projects,
  tickets,
  webhookDeliveries,
  webhooks,
} from "../src/server/db/schema";
import { getProcessing } from "../src/server/processing";
import {
  createWebhook,
  emitEvent,
  listWebhookDeliveries,
  listWebhooks,
  pingWebhook,
  updateWebhook,
} from "../src/server/webhooks";
import { runWebhooks } from "../src/worker/webhooks";
import { initializeStorage } from "../src/server/storage";
import { unsealSecret } from "../src/server/secrets";
import type { Action, Principal } from "../src/domain/permissions";
import type { WebhookEvent } from "../src/domain/webhooks";
// A signing secret of the right length, made when the test runs.
const signing = `whsec_${"a".repeat(24)}`;
// A channel of a messenger: the format, the address that is kept sealed, the subject that is off unless a person with
// config.approve switches it on, and what a delivery says.
const projectId = randomUUID();
const person = (name: string, kind: "human" | "agent", held: Action[]): Principal => ({
  id: `${name}-${projectId}`,
  kind,
  active: true,
  owner: false,
  grants: [{ projectId, actions: held }],
});
const base: Action[] = [
  "project.read",
  "ticket.read",
  "integration.manage",
  "config.read",
  "config.write",
];
const approver = person("approver", "human", [...base, "config.approve"]);
const writer = person("writer", "human", base);
const agent = person("agent", "agent", base);
interface Received {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
let server: Server;
let origin = "";
const received: Received[] = [];
// The path carries a key, like the address of an incoming webhook of a messenger.
const key = `KEY${randomUUID().replaceAll("-", "")}`;
const address = () => `${origin}/services/${key}`;
const channel = (extra: Record<string, unknown> = {}) => ({
  name: "Team channel",
  url: address(),
  format: "slack",
  events: ["ticket.created", "ticket.assigned", "ticket.overdue", "draft.created"],
  developmentOnly: true,
  ...extra,
});
async function reset() {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(webhooks).where(eq(webhooks.projectId, projectId));
  await db().delete(configChanges).where(eq(configChanges.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db()
    .update(projects)
    .set({ settings: {}, configVersion: 1 })
    .where(eq(projects.id, projectId));
  received.length = 0;
}
const drain = async () => {
  while (await runWebhooks({ projectId }));
};
async function ticket(subject = "Printer broken") {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject,
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      pendingSince: new Date(),
    })
    .returning();
  return { id: row?.id ?? "", number: row?.number ?? 0 };
}
const emit = (type: WebhookEvent, data: Record<string, unknown>) =>
  db().transaction((tx) => emitEvent(tx, projectId, type, data));
async function made(extra: Record<string, unknown> = {}) {
  const outcome = await createWebhook(approver, projectId, channel(extra));
  expect(outcome.outcome).toBe("applied");
  return outcome;
}
const lastBody = () => JSON.parse(received.at(-1)?.body ?? "{}") as { text?: string };
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values({
      id: projectId,
      name: "Support",
      slug: `channels-${projectId}`,
      defaultLanguage: "en",
    });
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.statusCode = 200;
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEV_BOOTSTRAP", "true");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => server.close(resolve));
  await reset();
  await db().delete(projects).where(eq(projects.id, projectId));
  await sqlClient().end();
});
beforeEach(reset);
describe("making a channel", () => {
  it("keeps the address sealed and shows the host only, in the list, the audit and the change", async () => {
    await made();
    const [row] = await listWebhooks(approver, projectId);
    expect(row).toMatchObject({
      format: "slack",
      withSubject: false,
      secretSet: true,
      url: origin,
    });
    expect(JSON.stringify(row)).not.toContain(key);
    // The address is in the table, sealed, in the place of the signing secret.
    const [stored] = await db().select().from(webhooks).where(eq(webhooks.projectId, projectId));
    expect(stored?.url).toBe(origin);
    expect(stored?.secretCiphertext).not.toContain(key);
    expect(unsealSecret(stored?.secretCiphertext ?? "")).toBe(address());
    // Neither the audit nor the record of the change holds it.
    const entries = await db().select().from(audit).where(eq(audit.projectId, projectId));
    expect(JSON.stringify(entries)).not.toContain(key);
    expect(JSON.stringify(entries)).toContain("/address");
    const changes = await db()
      .select()
      .from(configChanges)
      .where(eq(configChanges.projectId, projectId));
    expect(JSON.stringify(changes.map((change) => change.diff))).not.toContain(key);
    expect(JSON.stringify(changes.map((change) => change.payload))).not.toContain(key);
  });
  it("takes no signing secret and only the events that tell people about a ticket", async () => {
    await expect(
      createWebhook(approver, projectId, channel({ secret: signing })),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      createWebhook(approver, projectId, channel({ events: ["message.received"] })),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      createWebhook(
        approver,
        projectId,
        channel({ format: "aidesk", secret: signing, withSubject: true }),
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await listWebhooks(approver, projectId)).toEqual([]);
  });
  it("is a change that only a person with config.approve applies when it names the subject", async () => {
    // Without the subject, a person who may manage integrations applies it, an agent proposes it.
    expect((await createWebhook(writer, projectId, channel())).outcome).toBe("applied");
    await reset();
    expect((await createWebhook(agent, projectId, channel())).outcome).toBe("proposed");
    await reset();
    // With the subject, a person without config.approve proposes it, and nothing is made.
    const proposed = await createWebhook(writer, projectId, channel({ withSubject: true }));
    expect(proposed.outcome).toBe("proposed");
    expect(await listWebhooks(approver, projectId)).toEqual([]);
    await reset();
    expect((await createWebhook(approver, projectId, channel({ withSubject: true }))).outcome).toBe(
      "applied",
    );
  });
  it("switches the subject on only with config.approve, and off by anybody who may manage it", async () => {
    const outcome = await made();
    const version = outcome.version ?? 1;
    const proposal = await updateWebhook(writer, projectId, outcome.target ?? "", {
      expectedVersion: version,
      withSubject: true,
    });
    expect(proposal.outcome).toBe("proposed");
    expect((await listWebhooks(approver, projectId))[0]?.withSubject).toBe(false);
    const on = await updateWebhook(approver, projectId, outcome.target ?? "", {
      expectedVersion: version,
      withSubject: true,
    });
    expect(on.outcome).toBe("applied");
    expect((await listWebhooks(approver, projectId))[0]?.withSubject).toBe(true);
    const off = await updateWebhook(writer, projectId, outcome.target ?? "", {
      expectedVersion: on.version ?? 0,
      withSubject: false,
    });
    expect(off.outcome).toBe("applied");
  });
  it("keeps its format, takes no secret and refuses the events of the other format", async () => {
    const outcome = await made();
    const target = outcome.target ?? "";
    const version = outcome.version ?? 1;
    await expect(
      updateWebhook(approver, projectId, target, {
        expectedVersion: version,
        secret: signing,
      }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      updateWebhook(approver, projectId, target, {
        expectedVersion: version,
        events: ["ticket.created", "ai.budget_low"],
      }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      updateWebhook(approver, projectId, target, {
        expectedVersion: version,
        format: "teams",
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });
  it("replaces the address without showing it and writes that it was replaced", async () => {
    const outcome = await made();
    const next = `${origin}/services/${key}-new`;
    const changed = await updateWebhook(approver, projectId, outcome.target ?? "", {
      expectedVersion: outcome.version ?? 1,
      url: next,
    });
    expect(changed.outcome).toBe("applied");
    expect(changed.diff.map((entry) => entry.pointer)).toContain("/address");
    expect(JSON.stringify(changed.diff)).not.toContain(key);
    const [stored] = await db().select().from(webhooks).where(eq(webhooks.projectId, projectId));
    expect(unsealSecret(stored?.secretCiphertext ?? "")).toBe(next);
  });
});
describe("a delivery to a channel", () => {
  it("names the kind, the number and a link, is not signed, and leaves the subject out", async () => {
    await made();
    const made1 = await ticket("Printer broken");
    await emit("ticket.created", {
      ticketId: made1.id,
      number: made1.number,
      subject: "Printer broken",
    });
    await drain();
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe(`/services/${key}`);
    expect(received[0]?.headers["x-aidesk-signature"]).toBeUndefined();
    expect(received[0]?.headers["x-aidesk-event"]).toBeUndefined();
    const text = lastBody().text ?? "";
    expect(text).toContain("New ticket");
    expect(text).toContain("Support");
    expect(text).toContain(`#${String(made1.number)}`);
    expect(text).toContain(`?ticket=${made1.id}`);
    expect(text).not.toContain("Printer");
    const [delivery] = await db()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.projectId, projectId));
    expect(delivery).toMatchObject({ outcome: "succeeded", responseStatus: 200 });
  });
  it("names the subject once it is switched on, cleaned, and with no mention that works", async () => {
    const outcome = await made({ withSubject: true });
    expect(outcome.outcome).toBe("applied");
    const hooked = await ticket("Help @channel <!here> please");
    await emit("ticket.created", { ticketId: hooked.id, number: hooked.number });
    await drain();
    const text = lastBody().text ?? "";
    expect(text).toContain("Help");
    expect(text).not.toMatch(/@(?!\u200b)/);
    expect(text).not.toContain("<!here>");
    expect(text).toContain("&lt;!here&gt;");
  });
  it("is written in the language of the project", async () => {
    await made();
    await db().update(projects).set({ defaultLanguage: "de" }).where(eq(projects.id, projectId));
    const hooked = await ticket();
    await emit("ticket.overdue", { ticketId: hooked.id, number: hooked.number });
    await drain();
    expect(lastBody().text).toContain("Ticket überfällig");
    await db().update(projects).set({ defaultLanguage: "en" }).where(eq(projects.id, projectId));
  });
  it("does not announce a ticket that is gone, and says so in the log", async () => {
    await made();
    const gone = await ticket();
    await emit("ticket.created", { ticketId: gone.id, number: gone.number });
    await db().delete(tickets).where(eq(tickets.id, gone.id));
    await drain();
    expect(received).toHaveLength(0);
    const [delivery] = await db()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.projectId, projectId));
    expect(delivery).toMatchObject({ outcome: "skipped", code: "skipped:ticket" });
    const [job] = await db()
      .select()
      .from(jobs)
      .where(and(eq(jobs.projectId, projectId), eq(jobs.type, "webhook.deliver")));
    expect(job).toMatchObject({ status: "succeeded", lastErrorCode: "skipped:ticket" });
    const log = await listWebhookDeliveries(approver, projectId, delivery?.webhookId ?? "");
    expect(log[0]?.outcome).toBe("skipped");
  });
  it("sends a test message to the channel", async () => {
    const outcome = await made();
    await pingWebhook(approver, projectId, outcome.target ?? "");
    await drain();
    expect(lastBody().text).toContain("Test message");
    expect(lastBody().text).not.toContain("?ticket=");
  });
  it("tells a channel only the events it subscribed to", async () => {
    await made({ events: ["ticket.overdue"] });
    const hooked = await ticket();
    await emit("ticket.created", { ticketId: hooked.id, number: hooked.number });
    await drain();
    expect(received).toHaveLength(0);
    await emit("ticket.overdue", { ticketId: hooked.id, number: hooked.number });
    await drain();
    expect(received).toHaveLength(1);
  });
  it("writes the status change as resolved or reopened", async () => {
    await made({ events: ["ticket.status_changed"] });
    const hooked = await ticket();
    await emit("ticket.status_changed", {
      ticketId: hooked.id,
      number: hooked.number,
      from: "open",
      to: "resolved",
    });
    await drain();
    expect(lastBody().text).toContain("Ticket resolved");
  });
});
describe("the overview of the processing", () => {
  it("lists the channel with the subject only when it is switched on", async () => {
    const outcome = await made();
    const receives = async () =>
      (await getProcessing(approver, projectId)).entries.find((entry) => entry.group === "webhook")
        ?.receives;
    expect(await receives()).toEqual(["event_facts"]);
    await updateWebhook(approver, projectId, outcome.target ?? "", {
      expectedVersion: outcome.version ?? 1,
      withSubject: true,
    });
    expect(await receives()).toEqual(["event_facts", "subject"]);
    const entry = (await getProcessing(approver, projectId)).entries.find(
      (found) => found.group === "webhook",
    );
    // The host is shown, never the key.
    expect(JSON.stringify(entry)).not.toContain(key);
  });
});
describe("a webhook of the format aidesk", () => {
  it("is signed and carries the event as before", async () => {
    const secret = `whsec_${randomUUID()}`;
    await createWebhook(approver, projectId, {
      name: "Receiver",
      url: `${origin}/hook`,
      events: ["ticket.created"],
      secret,
      developmentOnly: true,
    });
    const hooked = await ticket();
    await emit("ticket.created", { ticketId: hooked.id, number: hooked.number });
    await drain();
    expect(received[0]?.headers["x-aidesk-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(JSON.parse(received[0]?.body ?? "{}")).toMatchObject({ type: "ticket.created" });
    expect((await listWebhooks(approver, projectId))[0]).toMatchObject({
      format: "aidesk",
      withSubject: false,
    });
  });
});
