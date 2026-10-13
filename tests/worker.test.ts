import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  connections,
  jobs,
  memberships,
  messages,
  projects,
  tickets,
  user,
} from "../src/server/db/schema";
import { initializeStorage } from "../src/server/storage";
import {
  createEmailDesign,
  getTestMail,
  selectEmailDesign,
  sendTestMail,
} from "../src/server/email-design";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
import { getSentSnapshot, getTicket } from "../src/server/operations";
import { emailTemplateVersion } from "../src/server/email";
import { runNext, runTestSend } from "../src/worker/jobs";
import type { Principal } from "../src/domain/permissions";
import { startFakeSmtp, type FakeSmtp } from "./support/smtp";
let smtp: FakeSmtp;
const projectIds: string[] = [];
const userIds: string[] = [];
interface Options {
  actorKind?: "human" | "agent" | "system";
  resolve?: boolean;
  acknowledgement?: boolean;
  settings?: Record<string, unknown>;
  transport?: "smtp" | "cloudflare";
  design?: Record<string, unknown>;
  // Queue another reply in a project that an earlier scenario set up.
  existing?: { projectId: string; connectionId: string; operatorId: string };
}
// A ticket with a customer message, our queued reply and its send job, in a
// project of its own so that the run is scoped to it.
async function scenario(options: Options = {}) {
  const projectId = options.existing?.projectId ?? randomUUID();
  const connectionId = options.existing?.connectionId ?? randomUUID();
  const operatorId = options.existing?.operatorId ?? `operator-${projectId}`;
  if (!options.existing) {
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
        kind: options.transport ?? "smtp",
        name: "Fake",
        direction: "outbound",
        status: "ready",
        config:
          options.transport === "cloudflare"
            ? {
                accountId: "a".repeat(32),
                from: "support@example.test",
                replyTo: "support@example.test",
              }
            : {
                host: "127.0.0.1",
                port: smtp.port,
                secure: false,
                from: "support@example.test",
                replyTo: "support@example.test",
                developmentOnly: true,
              },
        secretCiphertext:
          options.transport === "cloudflare"
            ? seal(JSON.stringify({ apiToken: "token-value" }), env().ENCRYPTION_KEY)
            : null,
      });
    if (options.design) {
      const owner: Principal = {
        id: "designer",
        kind: "human",
        active: true,
        owner: false,
        grants: [{ projectId, actions: ["project.read", "project.manage"] }],
      };
      await selectEmailDesign(
        owner,
        projectId,
        (await createEmailDesign(owner, projectId, options.design)).version,
      );
    }
    await db()
      .insert(user)
      .values({ id: operatorId, name: "Operator", email: `${operatorId}@example.test` });
    await db()
      .insert(memberships)
      .values({ userId: operatorId, projectId, actions: ["ticket.reply", "ticket.resolve"] });
  }
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
  await db().delete(audit).where(inArray(audit.projectId, projectIds));
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
      "an outgoing connection that is really an inbound one",
      "stale_or_paused_dispatch",
      async (e) => {
        await db()
          .update(connections)
          .set({ direction: "inbound" })
          .where(eq(connections.id, e.connectionId));
      },
    ],
    [
      "a connection that moved to another project",
      "stale_or_paused_dispatch",
      async (e) => {
        const other = await scenario();
        await db()
          .update(connections)
          .set({ projectId: other.projectId })
          .where(eq(connections.id, e.connectionId));
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
describe("designs of two projects", () => {
  const alpha = { accent: "#aa3355", headerText: "Alpha Support", footer: { en: "Alpha footer" } };
  const beta = {
    accent: "#118833",
    headerText: "Beta Care",
    footer: { en: "Beta footer" },
    fontFamily: "serif",
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  async function bySmtp(options: Options) {
    const entry = await scenario(options);
    await entry.run();
    const parsed = await simpleParser(Buffer.from(smtp.messages.at(-1) ?? ""));
    return { html: typeof parsed.html === "string" ? parsed.html : "", text: parsed.text ?? "" };
  }
  async function byCloudflare(options: Options) {
    const entry = await scenario({ ...options, transport: "cloudflare" });
    const fetch = vi.fn(() =>
      Promise.resolve(
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            delivered: ["alex@example.test"],
            queued: [],
            permanent_bounces: [],
            message_id: "<id@example.test>",
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await entry.run();
    expect(await entry.job()).toMatchObject({ status: "succeeded" });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    return JSON.parse(init.body as string) as { html: string; text: string };
  }
  it("sends each project's own design and plain text through SMTP", async () => {
    const [a, b, plain] = [
      await bySmtp({ design: alpha }),
      await bySmtp({ design: beta }),
      await bySmtp({}),
    ];
    expect(a.html).toContain("#aa3355");
    expect(a.html).toContain("Alpha Support");
    expect(a.text).toContain("Alpha footer");
    expect(b.html).toContain("#118833");
    expect(b.html).toContain("Georgia");
    expect(b.text).toContain("Beta footer");
    for (const [mail, other] of [
      [a, "Beta"],
      [b, "Alpha"],
    ] as const) {
      expect(mail.html).not.toContain(other);
      expect(mail.text).not.toContain(other);
    }
    // A project without a design keeps the built-in one.
    expect(plain.html).not.toContain("#aa3355");
    expect(plain.text).toContain("Worker");
    expect(plain.text).not.toContain("footer");
  });
  it("sends the same designs through the Cloudflare API", async () => {
    const [a, b] = [await byCloudflare({ design: alpha }), await byCloudflare({ design: beta })];
    expect(a.html).toContain("#aa3355");
    expect(a.text).toContain("Alpha footer");
    expect(b.html).toContain("#118833");
    expect(b.text).toContain("Beta footer");
    expect(a.html).not.toContain("Beta");
    expect(b.text).not.toContain("Alpha");
    // Both transports render the same mail for the same design.
    const viaSmtp = await bySmtp({ design: alpha });
    expect(viaSmtp.text.trim()).toBe(a.text.trim());
    expect(viaSmtp.html.replace(/\s+/g, "")).toBe(a.html.replace(/\s+/g, ""));
  });
  it("uses the version that is selected when the mail is sent", async () => {
    const entry = await scenario({ design: alpha });
    const owner: Principal = {
      id: "designer",
      kind: "human",
      active: true,
      owner: false,
      grants: [{ projectId: entry.projectId, actions: ["project.read", "project.manage"] }],
    };
    // A newer version is saved but not selected: the queued mail keeps the selected one.
    await createEmailDesign(owner, entry.projectId, beta);
    await entry.run();
    const first = await simpleParser(Buffer.from(smtp.messages.at(-1) ?? ""));
    expect(typeof first.html === "string" ? first.html : "").toContain("#aa3355");
    // Selecting it changes what is sent from then on.
    await selectEmailDesign(owner, entry.projectId, 2);
    const later = await scenario({ existing: entry });
    await later.run();
    const second = await simpleParser(Buffer.from(smtp.messages.at(-1) ?? ""));
    expect(typeof second.html === "string" ? second.html : "").toContain("#118833");
    // Each sent message names the version it was rendered with, and keeps it.
    const reader: Principal = {
      ...owner,
      id: "reader",
      grants: [{ projectId: entry.projectId, actions: ["ticket.read"] }],
    };
    expect((await getSentSnapshot(reader, entry.messageId)).designVersion).toBe(1);
    expect((await getSentSnapshot(reader, later.messageId)).designVersion).toBe(2);
    expect((await getSentSnapshot(reader, entry.messageId)).html).toContain("#aa3355");
    const builtIn = await scenario();
    await builtIn.run();
    expect(
      (
        await getSentSnapshot(
          { ...reader, grants: [{ projectId: builtIn.projectId, actions: ["ticket.read"] }] },
          builtIn.messageId,
        )
      ).designVersion,
    ).toBe(0);
  });
});
describe("snapshot of the sent mail", () => {
  it("keeps the mail as it was handed over and shows only its facts in the ticket", async () => {
    const entry = await scenario();
    await entry.run();
    const reader: Principal = {
      id: "reader",
      kind: "human",
      active: true,
      owner: false,
      grants: [{ projectId: entry.projectId, actions: ["project.read", "ticket.read"] }],
    };
    const snapshot = await getSentSnapshot(reader, entry.messageId);
    expect(snapshot).toMatchObject({
      transport: "smtp",
      to: "alex@example.test",
      from: "support@example.test",
      replyTo: "support@example.test",
      subject: "Re: Help",
      language: "en",
      templateVersion: emailTemplateVersion,
      markdown: "Answer",
    });
    expect(snapshot.html).toContain("Answer");
    expect(snapshot.text).toContain("Answer");
    // What the transport received carries the same subject and text.
    expect(smtp.messages[0]).toContain(`Subject: ${snapshot.subject}`);
    expect(smtp.messages[0]).toContain(snapshot.text.split("\n")[0] ?? "");
    // Later changes of the ticket or the message do not alter it.
    await db().update(tickets).set({ subject: "Changed" }).where(eq(tickets.id, entry.ticketId));
    await db()
      .update(messages)
      .set({ markdown: "Edited later" })
      .where(eq(messages.id, entry.messageId));
    expect((await getSentSnapshot(reader, entry.messageId)).subject).toBe("Re: Help");
    // The ticket view carries the facts, not the rendered mail.
    const shown = (await getTicket(reader, entry.ticketId)).messages.find(
      (message) => message.id === entry.messageId,
    );
    expect(shown?.sent).toMatchObject({
      subject: "Re: Help",
      templateVersion: emailTemplateVersion,
    });
    expect(JSON.stringify(shown)).not.toContain("<html");
    expect(shown?.source).toMatchObject({ messageId: `<${entry.messageId}@example.test>` });
    expect(shown?.source).not.toHaveProperty("sent");
  });
  it("exists only for sent messages and only for readers of the project", async () => {
    const sent = await scenario();
    await sent.run();
    const failed = await scenario();
    smtp.behaviour.rcpt = "550 5.1.1 User unknown";
    await failed.run();
    const reader = (
      projectId: string,
      actions: ("ticket.read" | "project.read")[] = ["ticket.read"],
    ): Principal => ({
      id: "reader",
      kind: "human",
      active: true,
      owner: false,
      grants: [{ projectId, actions }],
    });
    await expect(getSentSnapshot(reader(failed.projectId), failed.messageId)).rejects.toMatchObject(
      { code: "not_found" },
    );
    await expect(
      getSentSnapshot(reader(sent.projectId, ["project.read"]), sent.messageId),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(getSentSnapshot(reader(failed.projectId), sent.messageId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      getSentSnapshot({ ...reader(sent.projectId), grants: [] }, sent.messageId),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(getSentSnapshot(reader(sent.projectId), randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
    // A message hidden as a note is not served even if it carries one.
    await db().update(messages).set({ internal: true }).where(eq(messages.id, sent.messageId));
    await expect(getSentSnapshot(reader(sent.projectId), sent.messageId)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await sent.message())?.deliveryState).toBe("sent");
    expect((await failed.message())?.source).not.toHaveProperty("sent");
  });
});
describe("test send of a design", () => {
  const alpha = { accent: "#aa3355", headerText: "Alpha Support" };
  const beta = { accent: "#118833", headerText: "Beta Care" };
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  // A project with a selected design and a person who manages it.
  async function managed(options: Options = {}) {
    const entry = await scenario({ design: alpha, ...options });
    await db()
      .update(memberships)
      .set({ actions: ["ticket.reply", "project.read", "project.manage"] })
      .where(eq(memberships.userId, entry.operatorId));
    const manager: Principal = {
      id: entry.operatorId,
      kind: "human",
      active: true,
      owner: false,
      grants: [{ projectId: entry.projectId, actions: ["project.read", "project.manage"] }],
    };
    return { entry, manager, address: `${entry.operatorId}@example.test` };
  }
  const html = async () => {
    const parsed = await simpleParser(Buffer.from(smtp.messages.at(-1) ?? ""));
    return { parsed, html: typeof parsed.html === "string" ? parsed.html : "" };
  };
  it("sends the selected design to the person who asked and creates no ticket", async () => {
    const { entry, manager, address } = await managed();
    const before = await db().select().from(messages).where(eq(messages.ticketId, entry.ticketId));
    const { id } = await sendTestMail(manager, entry.projectId, {});
    expect(await getTestMail(manager, id)).toMatchObject({ status: "queued", code: null });
    expect(await runTestSend({ projectId: entry.projectId })).toBe(true);
    const sent = await html();
    expect(sent.parsed.to).toMatchObject({ value: [{ address: address }] });
    expect(sent.parsed.subject).toBe("[Test] Worker, design version 1");
    expect(sent.html).toContain("#aa3355");
    expect(sent.html).toContain("test message to check the design");
    expect(await getTestMail(manager, id)).toMatchObject({ status: "succeeded", code: null });
    // Nothing of the project's tickets changed, and the reply job is untouched.
    expect(
      await db().select().from(messages).where(eq(messages.ticketId, entry.ticketId)),
    ).toHaveLength(before.length);
    expect((await entry.job())?.status).toBe("queued");
    expect(
      await db()
        .select()
        .from(audit)
        .where(and(eq(audit.projectId, entry.projectId), eq(audit.action, "design.test_send"))),
    ).toHaveLength(1);
    // A finished test is not sent again.
    expect(await runTestSend({ projectId: entry.projectId })).toBe(false);
  });
  it("uses a chosen version and language", async () => {
    const { entry, manager } = await managed();
    await createEmailDesign(manager, entry.projectId, beta);
    await sendTestMail(manager, entry.projectId, { version: 2, language: "de" });
    await runTestSend({ projectId: entry.projectId });
    const second = await html();
    expect(second.html).toContain("#118833");
    expect(second.parsed.subject).toBe("[Test] Worker, design version 2");
    expect(second.html).toContain("Testnachricht");
    await sendTestMail(manager, entry.projectId, { version: 0 });
    await runTestSend({ projectId: entry.projectId });
    const builtIn = await html();
    expect(builtIn.html).not.toContain("#aa3355");
    expect(builtIn.parsed.subject).toBe("[Test] Worker, design version 0");
    await expect(sendTestMail(manager, entry.projectId, { version: 99 })).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("goes through the Cloudflare API like a reply", async () => {
    const { entry, manager, address } = await managed({ transport: "cloudflare" });
    const fetch = vi.fn(() =>
      Promise.resolve(
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            delivered: [address],
            queued: [],
            permanent_bounces: [],
            message_id: "<t@example.test>",
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await sendTestMail(manager, entry.projectId, {});
    await runTestSend({ projectId: entry.projectId });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { to: string; subject: string; html: string };
    expect(body).toMatchObject({ to: address, subject: "[Test] Worker, design version 1" });
    expect(body.html).toContain("#aa3355");
  });
  it("cannot be addressed elsewhere and is limited to people who manage the project", async () => {
    const { entry, manager } = await managed();
    await expect(
      sendTestMail(manager, entry.projectId, { to: "someone@example.test" }),
    ).rejects.toThrow();
    await expect(sendTestMail(manager, entry.projectId, { version: -1 })).rejects.toThrow();
    const reader: Principal = {
      ...manager,
      grants: [{ projectId: entry.projectId, actions: ["project.read"] }],
    };
    await expect(sendTestMail(reader, entry.projectId, {})).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      sendTestMail({ ...manager, kind: "agent" }, entry.projectId, {}),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      sendTestMail({ ...manager, grants: [] }, entry.projectId, {}),
    ).rejects.toMatchObject({ code: "not_found" });
    await db().update(user).set({ active: false }).where(eq(user.id, manager.id));
    await expect(sendTestMail(manager, entry.projectId, {})).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(smtp.messages).toHaveLength(0);
  });
  it("needs an outgoing connection that is not paused", async () => {
    const { entry, manager } = await managed();
    await db()
      .update(projects)
      .set({ settings: { outboundConnectionId: entry.connectionId, pauseOutgoing: true } })
      .where(eq(projects.id, entry.projectId));
    await expect(sendTestMail(manager, entry.projectId, {})).rejects.toMatchObject({
      code: "conflict",
    });
    await db().update(projects).set({ settings: {} }).where(eq(projects.id, entry.projectId));
    await expect(sendTestMail(manager, entry.projectId, {})).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("allows ten per hour and shows the result only to the person who asked", async () => {
    const { entry, manager } = await managed();
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1)
      ids.push((await sendTestMail(manager, entry.projectId, {})).id);
    await expect(sendTestMail(manager, entry.projectId, {})).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
    // Another person is counted separately, and cannot see someone else's test.
    const other = await managed();
    const second = await sendTestMail(other.manager, other.entry.projectId, {});
    await expect(getTestMail(manager, second.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getTestMail(other.manager, ids[0] ?? "")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getTestMail({ ...manager, grants: [] }, ids[0] ?? "")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getTestMail(manager, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(getTestMail(manager, entry.messageId)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("sends nothing when the situation changed before the worker ran", async () => {
    const cases: [string, string, (e: Awaited<ReturnType<typeof managed>>) => Promise<void>][] = [
      [
        "the manage permission was withdrawn",
        "dispatch_grant_revoked",
        async (m) => {
          await db()
            .update(memberships)
            .set({ actions: ["project.read"] })
            .where(eq(memberships.userId, m.entry.operatorId));
        },
      ],
      [
        "the person was disabled",
        "dispatch_grant_revoked",
        async (m) => {
          await db().update(user).set({ active: false }).where(eq(user.id, m.entry.operatorId));
        },
      ],
      [
        "outgoing mail was paused",
        "stale_or_paused_dispatch",
        async (m) => {
          await db()
            .update(projects)
            .set({ settings: { outboundConnectionId: m.entry.connectionId, pauseOutgoing: true } })
            .where(eq(projects.id, m.entry.projectId));
        },
      ],
      [
        "the connection was replaced",
        "stale_or_paused_dispatch",
        async (m) => {
          await db()
            .update(projects)
            .set({ settings: { outboundConnectionId: randomUUID() } })
            .where(eq(projects.id, m.entry.projectId));
        },
      ],
      [
        "the connection is not ready",
        "outbound_not_ready",
        async (m) => {
          await db()
            .update(connections)
            .set({ status: "degraded" })
            .where(eq(connections.id, m.entry.connectionId));
        },
      ],
    ];
    for (const [name, code, change] of cases) {
      const m = await managed();
      const { id } = await sendTestMail(m.manager, m.entry.projectId, {});
      await change(m);
      expect(await runTestSend({ projectId: m.entry.projectId }), name).toBe(true);
      expect(await getTestMail(m.manager, id), name).toMatchObject({ status: "review", code });
      expect(smtp.messages, name).toHaveLength(0);
    }
  });
  it("reports a refusal of the transport and does not retry or replay", async () => {
    const { entry, manager } = await managed();
    smtp.behaviour.rcpt = "550 5.1.1 User unknown";
    const { id } = await sendTestMail(manager, entry.projectId, {});
    await runTestSend({ projectId: entry.projectId });
    expect(await getTestMail(manager, id)).toMatchObject({
      status: "review",
      code: "transport_rejected",
    });
    expect(await runTestSend({ projectId: entry.projectId })).toBe(false);
    // A dispatch whose lease ran out is not sent: it may already have left.
    const second = await sendTestMail(manager, entry.projectId, {});
    await db()
      .update(jobs)
      .set({ status: "running", leaseToken: randomUUID(), leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, second.id));
    expect(await runTestSend({ projectId: entry.projectId })).toBe(false);
    expect(await getTestMail(manager, second.id)).toMatchObject({
      status: "review",
      code: "expired_dispatch_lease",
    });
    expect(smtp.connections).toBe(1);
  });
  it("does not write a result for a job whose lease was taken over", async () => {
    const { entry, manager } = await managed();
    const { id } = await sendTestMail(manager, entry.projectId, {});
    smtp.behaviour.onData = async () => {
      await db().update(jobs).set({ leaseToken: randomUUID() }).where(eq(jobs.id, id));
    };
    await runTestSend({ projectId: entry.projectId });
    expect(await getTestMail(manager, id)).toMatchObject({ status: "running" });
  });
});
