import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  connections,
  jobs,
  memberships,
  messages,
  projects,
  tickets,
  user,
} from "../src/server/db/schema";
import { initializeStorage } from "../src/server/storage";
import { runNext } from "../src/worker/jobs";
import { startFakeSmtp, type FakeSmtp } from "./support/smtp";
let smtp: FakeSmtp;
const projectIds: string[] = [];
const userIds: string[] = [];
interface Options {
  actorKind?: "human" | "agent" | "system";
  resolve?: boolean;
  acknowledgement?: boolean;
  settings?: Record<string, unknown>;
}
// A ticket with a customer message, our queued reply and its send job, in a
// project of its own so that the run is scoped to it.
async function scenario(options: Options = {}) {
  const projectId = randomUUID();
  const connectionId = randomUUID();
  const operatorId = `operator-${projectId}`;
  projectIds.push(projectId);
  userIds.push(operatorId);
  await db()
    .insert(projects)
    .values({
      id: projectId,
      name: "Worker",
      slug: `worker-${projectId}`,
      settings: {
        outboundConnectionId: connectionId,
        acknowledgements: options.acknowledgement === true,
        ...options.settings,
      },
    });
  await db()
    .insert(connections)
    .values({
      id: connectionId,
      projectId,
      kind: "smtp",
      name: "Fake",
      direction: "outbound",
      status: "ready",
      config: {
        host: "127.0.0.1",
        port: smtp.port,
        secure: false,
        from: "support@example.test",
        replyTo: "support@example.test",
        developmentOnly: true,
      },
    });
  await db()
    .insert(user)
    .values({ id: operatorId, name: "Operator", email: `${operatorId}@example.test` });
  await db()
    .insert(memberships)
    .values({ userId: operatorId, projectId, actions: ["ticket.reply", "ticket.resolve"] });
  const [ticket] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Help",
      requesterEmail: "alex@example.test",
      requesterName: "Alex",
      language: "en",
      pendingSince: new Date(Date.now() - 3_600_000),
    })
    .returning();
  if (!ticket) throw new Error("ticket");
  const customerId = `<${randomUUID()}@example.test>`;
  await db()
    .insert(messages)
    .values({
      ticketId: ticket.id,
      authorType: "customer",
      authorName: "Alex",
      authorEmail: "alex@example.test",
      markdown: "Question",
      language: "en",
      receivedMessageId: customerId,
      deliveryState: "received",
      createdAt: new Date(Date.now() - 3_000_000),
    });
  const [reply] = await db()
    .insert(messages)
    .values({
      ticketId: ticket.id,
      authorType: options.acknowledgement ? "system" : "human",
      authorName: "Operator",
      markdown: "Answer",
      language: "en",
      deliveryState: "queued",
      source: options.acknowledgement ? { kind: "acknowledgement" } : {},
    })
    .returning();
  if (!reply) throw new Error("message");
  const actorKind = options.actorKind ?? (options.acknowledgement ? "system" : "human");
  const [job] = await db()
    .insert(jobs)
    .values({
      projectId,
      type: "mail.send",
      dedupKey: `worker-test:${randomUUID()}`,
      payload: {
        ticketId: ticket.id,
        messageId: reply.id,
        connectionId,
        actorId:
          actorKind === "human" ? operatorId : actorKind === "agent" ? randomUUID() : "system",
        actorKind,
        expectedRevision: ticket.revision,
        resolve: options.resolve === true,
      },
    })
    .returning();
  if (!job) throw new Error("job");
  return {
    projectId,
    connectionId,
    operatorId,
    ticketId: ticket.id,
    messageId: reply.id,
    jobId: job.id,
    customerId,
    run: () => runNext({ projectId }),
    job: async () => (await db().select().from(jobs).where(eq(jobs.id, job.id)))[0],
    message: async () => (await db().select().from(messages).where(eq(messages.id, reply.id)))[0],
    ticket: async () => (await db().select().from(tickets).where(eq(tickets.id, ticket.id)))[0],
  };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEV_BOOTSTRAP", "true");
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  smtp = await startFakeSmtp();
});
beforeEach(() => {
  smtp.connections = 0;
  smtp.messages.length = 0;
  smtp.behaviour = {};
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await smtp.close();
  await db().delete(jobs).where(inArray(jobs.projectId, projectIds));
  await db().delete(tickets).where(inArray(tickets.projectId, projectIds));
  await db().delete(projects).where(inArray(projects.id, projectIds));
  await db().delete(user).where(inArray(user.id, userIds));
  await sqlClient().end();
});
// A job that did not send must leave the ticket and the transport untouched.
async function expectReview(entry: Scenario, code: string, sent = 0) {
  expect(await entry.job()).toMatchObject({ status: "review", lastErrorCode: code });
  expect(await entry.message()).toMatchObject({
    deliveryState: "review",
    source: { deliveryError: code },
  });
  expect(smtp.messages).toHaveLength(sent);
  const ticket = await entry.ticket();
  expect(ticket?.status).toBe("open");
  expect(ticket?.pendingSince).not.toBeNull();
}
describe("sending a reply", () => {
  it("hands the message over once and records the acceptance", async () => {
    const entry = await scenario();
    expect(await entry.run()).toBe(true);
    expect(smtp.messages).toHaveLength(1);
    const wire = smtp.messages[0] ?? "";
    expect(wire).toContain("From: Worker <support@example.test>");
    expect(wire).toContain("Reply-To: support@example.test");
    expect(wire).toContain(`X-Aidesk-Ticket: ${entry.ticketId}`);
    expect(wire).toContain(`In-Reply-To: ${entry.customerId}`);
    expect(wire).not.toContain("Auto-Submitted");
    expect(await entry.job()).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(await entry.message()).toMatchObject({
      deliveryState: "sent",
      source: { messageId: `<${entry.messageId}@example.test>` },
    });
    expect(await entry.ticket()).toMatchObject({ status: "waiting", pendingSince: null });
    // Nothing is left to send, and the finished job is not run again.
    expect(await entry.run()).toBe(false);
    expect(smtp.messages).toHaveLength(1);
  });
  it("resolves the ticket when the reply asked for it", async () => {
    const entry = await scenario({ resolve: true });
    await entry.run();
    const ticket = await entry.ticket();
    expect(ticket?.status).toBe("resolved");
    expect(ticket?.resolvedAt).not.toBeNull();
  });
  it("marks an acknowledgement as automatic and leaves the ticket alone", async () => {
    const entry = await scenario({ acknowledgement: true });
    await entry.run();
    expect(smtp.messages[0]).toContain("Auto-Submitted: auto-replied");
    expect(smtp.messages[0]).toContain("X-Auto-Response-Suppress: All");
    expect(await entry.message()).toMatchObject({ deliveryState: "sent" });
    const ticket = await entry.ticket();
    expect(ticket?.status).toBe("open");
    expect(ticket?.pendingSince).not.toBeNull();
  });
  it("keeps the obligation when the customer wrote again while the mail was in flight", async () => {
    const entry = await scenario();
    smtp.behaviour.onData = async () => {
      await db().update(tickets).set({ revision: 99 }).where(eq(tickets.id, entry.ticketId));
    };
    await entry.run();
    expect((await entry.message())?.deliveryState).toBe("sent");
    const ticket = await entry.ticket();
    expect(ticket?.status).toBe("open");
    expect(ticket?.pendingSince).not.toBeNull();
  });
});
describe("stale or forbidden dispatch", () => {
  const cases: [string, string, (entry: Scenario) => Promise<void>, Options?][] = [
    [
      "a newer revision of the ticket",
      "stale_or_paused_dispatch",
      async (e) => {
        await db().update(tickets).set({ revision: 7 }).where(eq(tickets.id, e.ticketId));
      },
    ],
    [
      "paused outgoing mail",
      "stale_or_paused_dispatch",
      async (e) => {
        await db()
          .update(projects)
          .set({ settings: { outboundConnectionId: e.connectionId, pauseOutgoing: true } })
          .where(eq(projects.id, e.projectId));
      },
    ],
    [
      "another outgoing connection of the project",
      "stale_or_paused_dispatch",
      async (e) => {
        await db()
          .update(projects)
          .set({ settings: { outboundConnectionId: randomUUID() } })
          .where(eq(projects.id, e.projectId));
      },
    ],
    [
      "a ticket moved to junk",
      "stale_or_paused_dispatch",
      async (e) => {
        await db().update(tickets).set({ junkAt: new Date() }).where(eq(tickets.id, e.ticketId));
      },
    ],
    [
      "a message turned into a private note",
      "stale_or_paused_dispatch",
      async (e) => {
        await db().update(messages).set({ internal: true }).where(eq(messages.id, e.messageId));
      },
    ],
    [
      "a connection that is not ready",
      "outbound_not_ready",
      async (e) => {
        await db()
          .update(connections)
          .set({ status: "degraded" })
          .where(eq(connections.id, e.connectionId));
      },
    ],
    [
      "an operator who lost the reply permission",
      "dispatch_grant_revoked",
      async (e) => {
        await db().delete(memberships).where(eq(memberships.userId, e.operatorId));
      },
    ],
    [
      "a disabled operator",
      "dispatch_grant_revoked",
      async (e) => {
        await db().update(user).set({ active: false }).where(eq(user.id, e.operatorId));
      },
    ],
    [
      "an operator without permission to resolve",
      "dispatch_grant_revoked",
      async (e) => {
        await db()
          .update(memberships)
          .set({ actions: ["ticket.reply"] })
          .where(eq(memberships.userId, e.operatorId));
      },
      { resolve: true },
    ],
    [
      "an unknown agent",
      "autonomous_dispatch_not_enabled",
      () => Promise.resolve(),
      { actorKind: "agent" },
    ],
    [
      "an acknowledgement after the project switched them off",
      "acknowledgement_not_enabled",
      async (e) => {
        await db()
          .update(projects)
          .set({ settings: { outboundConnectionId: e.connectionId, acknowledgements: false } })
          .where(eq(projects.id, e.projectId));
      },
      { acknowledgement: true, settings: {} },
    ],
    [
      "system authority for a message that is not an acknowledgement",
      "acknowledgement_not_enabled",
      () => Promise.resolve(),
      { actorKind: "system", acknowledgement: false, settings: { acknowledgements: true } },
    ],
  ];
  for (const [name, code, change, options] of cases)
    it(`sends nothing after ${name}`, async () => {
      const entry = await scenario(options);
      await change(entry);
      expect(await entry.run()).toBe(true);
      await expectReview(entry, code);
      // It is not picked up again.
      expect(await entry.run()).toBe(false);
      expect(smtp.messages).toHaveLength(0);
    });
  it("counter-probe: the same setup sends when nothing was changed", async () => {
    for (const options of [{ resolve: true }, { acknowledgement: true }]) {
      const entry = await scenario(options);
      await entry.run();
      expect(await entry.job()).toMatchObject({ status: "succeeded" });
    }
  });
  it("refuses a development connection outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const entry = await scenario();
      await entry.run();
      await expectReview(entry, "development_connection_not_allowed");
    } finally {
      vi.stubEnv("NODE_ENV", "development");
    }
  });
});
describe("uncertain and failed transports", () => {
  it("treats a refusal before the message as not sent and does not retry", async () => {
    smtp.behaviour.rcpt = "550 5.1.1 User unknown";
    const entry = await scenario();
    await entry.run();
    await expectReview(entry, "transport_rejected");
    expect(await entry.job()).toMatchObject({ attempts: 1 });
    expect(await entry.run()).toBe(false);
    expect(smtp.messages).toHaveLength(0);
  });
  it("treats a temporary refusal of the message as not sent and does not retry", async () => {
    smtp.behaviour.data = "451 4.3.0 try again later";
    const entry = await scenario();
    await entry.run();
    await expectReview(entry, "transport_rejected", 1);
    expect(await entry.run()).toBe(false);
    expect(smtp.messages).toHaveLength(1);
  });
  it("treats a connection lost before the message as not sent", async () => {
    smtp.behaviour.dropAtConnect = true;
    const entry = await scenario();
    await entry.run();
    await expectReview(entry, "transport_rejected");
    expect(await entry.run()).toBe(false);
  });
  it("keeps acceptance unknown when the connection ends with the message in flight", async () => {
    smtp.behaviour.dropAfterData = true;
    const entry = await scenario();
    await entry.run();
    await expectReview(entry, "transport_acceptance_unknown", 1);
    expect(await entry.job()).toMatchObject({ attempts: 1 });
    // A later run must not hand the message over a second time.
    expect(await entry.run()).toBe(false);
    expect(smtp.messages).toHaveLength(1);
  });
});
describe("leases and fencing", () => {
  const expire = (entry: Scenario, token: string | null = randomUUID()) =>
    db()
      .update(jobs)
      .set({ status: "running", leaseToken: token, leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, entry.jobId));
  it("sends nothing for a dispatch whose lease ran out, and asks for a decision", async () => {
    const entry = await scenario();
    await expire(entry);
    expect(await entry.run()).toBe(false);
    expect(await entry.job()).toMatchObject({
      status: "review",
      lastErrorCode: "expired_dispatch_lease",
      leaseUntil: null,
    });
    expect(await entry.message()).toMatchObject({
      deliveryState: "review",
      source: { deliveryError: "expired_dispatch_lease" },
    });
    expect(smtp.connections).toBe(0);
    expect(smtp.messages).toHaveLength(0);
  });
  it("counter-probe: a running dispatch with a valid lease is left alone", async () => {
    const entry = await scenario();
    await db()
      .update(jobs)
      .set({
        status: "running",
        leaseToken: randomUUID(),
        leaseUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(jobs.id, entry.jobId));
    expect(await entry.run()).toBe(false);
    expect(await entry.job()).toMatchObject({ status: "running" });
    expect((await entry.message())?.deliveryState).toBe("queued");
  });
  it("does not record a result for a job whose lease another worker took over", async () => {
    const entry = await scenario();
    const stolen = randomUUID();
    smtp.behaviour.onData = async () => {
      await db().update(jobs).set({ leaseToken: stolen }).where(eq(jobs.id, entry.jobId));
    };
    await entry.run();
    // The old holder writes neither success nor failure.
    expect(await entry.job()).toMatchObject({ status: "running", leaseToken: stolen });
    expect((await entry.message())?.deliveryState).toBe("queued");
    expect(await entry.ticket()).toMatchObject({ status: "open" });
    // When that lease ends too, the uncertain send goes to review, not to a resend.
    await db()
      .update(jobs)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, entry.jobId));
    expect(await entry.run()).toBe(false);
    expect(await entry.job()).toMatchObject({
      status: "review",
      lastErrorCode: "expired_dispatch_lease",
    });
    expect(smtp.messages).toHaveLength(1);
  });
  it("lets only one of two workers claim a queued job", async () => {
    const entry = await scenario();
    const results = await Promise.all([entry.run(), entry.run()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(smtp.messages).toHaveLength(1);
    expect(await entry.job()).toMatchObject({ status: "succeeded", attempts: 1 });
  });
  it("does not touch jobs of other projects when scoped", async () => {
    const mine = await scenario();
    const other = await scenario();
    await mine.run();
    expect((await other.job())?.status).toBe("queued");
    await other.run();
    expect(
      await db()
        .select()
        .from(jobs)
        .where(and(inArray(jobs.id, [mine.jobId, other.jobId]), eq(jobs.status, "succeeded"))),
    ).toHaveLength(2);
  });
});
