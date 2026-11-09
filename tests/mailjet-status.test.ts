import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { connections, messages, projects, tickets } from "../src/server/db/schema";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
import { fetchMailjetStatus } from "../src/server/mailjet";
import { scanMailjetStatus } from "../src/server/mailjet-status";
import {
  checkDelaysMs,
  interpretStatus,
  nextCheckAt,
  stateReason,
} from "../src/domain/mailjet-status";
describe("the status of a message in Mailjet", () => {
  it("is a failure for a hard bounce, a block and a permanent state, and names the reason", () => {
    expect(interpretStatus({ status: "hardbounced", stateId: 1, permanent: true })).toEqual({
      kind: "failed",
      diagnostic: "Mailjet: hardbounced, state 1 (recipient)",
    });
    expect(interpretStatus({ status: "blocked", stateId: 20, permanent: null })).toMatchObject({
      kind: "failed",
      diagnostic: "Mailjet: blocked, state 20 (recipient blacklisted)",
    });
    expect(interpretStatus({ status: "bounce", stateId: 2, permanent: true }).kind).toBe("failed");
    // A text that is not a status of Mailjet does not reach the record.
    expect(interpretStatus({ status: "x@example.test", stateId: null, permanent: true })).toEqual({
      kind: "failed",
      diagnostic: "Mailjet: unknown",
    });
  });
  it("is not final for a soft bounce, a deferral or a message that is still queued", () => {
    for (const status of ["softbounced", "deferred", "queued", "unknown", "bounce", "other"])
      expect(interpretStatus({ status, stateId: 13, permanent: false })).toEqual({
        kind: "pending",
      });
    for (const status of ["sent", "opened", "clicked", "spam", "unsub"])
      expect(interpretStatus({ status, stateId: null, permanent: null })).toEqual({
        kind: "delivered",
      });
  });
  it("groups the states and plans the checks at growing distances until they end", () => {
    expect([1, 5, 8, 11, 13, 15, 17, 19, 20, 21].map(stateReason)).toEqual([
      "recipient",
      "domain",
      "spam filter",
      "system",
      "greylisted",
      "prevented by Mailjet",
      "content",
      "typo fix",
      "recipient blacklisted",
      "spam report",
    ]);
    expect(stateReason(99)).toBeNull();
    expect(stateReason(null)).toBeNull();
    const from = new Date("2026-11-10T10:00:00Z");
    expect(nextCheckAt(0, from)?.toISOString()).toBe("2026-11-10T10:02:00.000Z");
    expect(nextCheckAt(5, from)?.toISOString()).toBe("2026-11-11T10:00:00.000Z");
    expect(nextCheckAt(checkDelaysMs.length, from)).toBeNull();
  });
});
describe("the status call of Mailjet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const secret = { apiKey: "key-value", secretKey: "secret-value" };
  const answer = (status: number, text: string) => {
    const fetch = vi.fn(() => Promise.resolve(new Response(text, { status })));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };
  it("reads the status of one message by its numeric id", async () => {
    const fetch = answer(
      200,
      '{"Count":1,"Data":[{"ID":1152921512359371122,"Status":"HardBounced","StateID":1,"StatePermanent":true}],"Total":1}',
    );
    expect(await fetchMailjetStatus(secret, "1152921512359371122")).toEqual({
      status: "hardbounced",
      stateId: 1,
      permanent: true,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.mailjet.com/v3/REST/message/1152921512359371122");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("key-value:secret-value").toString("base64")}`,
    );
    answer(200, '{"Data":[{"Status":"sent"}]}');
    expect(await fetchMailjetStatus(secret, "42")).toEqual({
      status: "sent",
      stateId: null,
      permanent: null,
    });
  });
  it("tells a refused key, a limit, an unknown message and a failure apart", async () => {
    for (const [status, code] of [
      [401, "mailjet_auth_failed"],
      [403, "mailjet_auth_failed"],
      [429, "mailjet_rate_limited"],
      [404, "mailjet_status_not_found"],
      [500, "mailjet_status_unavailable"],
    ] as const) {
      answer(status, "{}");
      await expect(fetchMailjetStatus(secret, "42")).rejects.toThrow(code);
    }
    answer(200, '{"Data":[]}');
    await expect(fetchMailjetStatus(secret, "42")).rejects.toThrow("mailjet_status_unavailable");
    answer(200, "not json");
    await expect(fetchMailjetStatus(secret, "42")).rejects.toThrow("mailjet_status_unavailable");
    const fetch = answer(200, "{}");
    await expect(fetchMailjetStatus(secret, "../4")).rejects.toThrow("mailjet_status_unavailable");
    expect(fetch).not.toHaveBeenCalled();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("timeout"))),
    );
    await expect(fetchMailjetStatus(secret, "42")).rejects.toThrow("mailjet_status_unavailable");
  });
});
const projectIds: string[] = [];
const now = new Date("2026-11-10T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
// A project that sends through Mailjet, and a reply that it sent a while ago.
async function sentReply(options: { transport?: string; sentMinutesAgo: number; source?: object }) {
  const projectId = randomUUID();
  const connectionId = randomUUID();
  const providerId = String(Math.floor(Math.random() * 9e14) + 1e14);
  projectIds.push(projectId);
  await db()
    .insert(projects)
    .values({
      id: projectId,
      name: "Status",
      slug: `status-${projectId}`,
      settings: { outboundConnectionId: connectionId },
    });
  await db()
    .insert(connections)
    .values({
      id: connectionId,
      projectId,
      kind: "mailjet",
      name: "Mailjet",
      direction: "outbound",
      status: "ready",
      config: { from: "support@example.test", replyTo: "support@example.test" },
      secretCiphertext: seal(
        JSON.stringify({ apiKey: "key-value", secretKey: "secret-value" }),
        env().ENCRYPTION_KEY,
      ),
    });
  const [ticket] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Help",
      requesterEmail: "alex@example.test",
      requesterName: "Alex",
      language: "en",
      status: "waiting",
      waitingSince: minutesAgo(options.sentMinutesAgo),
    })
    .returning();
  if (!ticket) throw new Error("ticket");
  const [message] = await db()
    .insert(messages)
    .values({
      ticketId: ticket.id,
      authorType: "human",
      authorName: "Operator",
      markdown: "Answer",
      language: "en",
      deliveryState: "sent",
      createdAt: minutesAgo(options.sentMinutesAgo + 1),
      source: {
        messageId: "<m@example.test>",
        sent: {
          at: minutesAgo(options.sentMinutesAgo).toISOString(),
          transport: options.transport ?? "mailjet",
          providerId,
        },
        ...options.source,
      },
    })
    .returning();
  if (!message) throw new Error("message");
  return {
    projectId,
    providerId,
    ticketId: ticket.id,
    messageId: message.id,
    message: async () => (await db().select().from(messages).where(eq(messages.id, message.id)))[0],
    ticket: async () => (await db().select().from(tickets).where(eq(tickets.id, ticket.id)))[0],
  };
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db().delete(tickets).where(inArray(tickets.projectId, projectIds));
  await db().delete(projects).where(inArray(projects.id, projectIds));
  await sqlClient().end();
});
describe("the pass over replies that went out through Mailjet", () => {
  // Every scenario shares the database, so a call answers for the message of one scenario and says
  // that Mailjet cannot answer for the others, which leaves them as they are.
  const asked: string[] = [];
  const answers = (
    id: string,
    value: string,
    stateId: number | null = null,
    permanent: boolean | null = null,
  ) =>
    vi.fn((_secret: unknown, providerId: string) => {
      asked.push(providerId);
      return providerId === id
        ? Promise.resolve({ status: value, stateId, permanent })
        : Promise.reject(new Error("mailjet_status_unavailable"));
    });
  const rejects = (id: string, code: string) =>
    vi.fn((_secret: unknown, providerId: string) => {
      asked.push(providerId);
      return providerId === id
        ? Promise.reject(new Error(code))
        : Promise.reject(new Error("mailjet_status_unavailable"));
    });
  afterEach(() => {
    asked.length = 0;
  });
  it("asks only when a check is due, once the first minute has passed", async () => {
    const early = await sentReply({ sentMinutesAgo: 0.5 });
    await scanMailjetStatus(now, answers(early.providerId, "sent"));
    expect(asked).not.toContain(early.providerId);
    expect((await early.message())?.source.deliveryStatus).toBeUndefined();
  });
  it("records a delivery and plans the next check, and leaves the ticket as it is", async () => {
    const entry = await sentReply({ sentMinutesAgo: 3 });
    const fetch = answers(entry.providerId, "sent");
    expect((await scanMailjetStatus(now, fetch)).failed).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      { apiKey: "key-value", secretKey: "secret-value" },
      entry.providerId,
    );
    const message = await entry.message();
    expect(message?.deliveryState).toBe("sent");
    expect(message?.source).toMatchObject({
      messageId: "<m@example.test>",
      deliveryStatus: {
        provider: "mailjet",
        status: "sent",
        checks: 1,
        nextCheckAt: "2026-11-10T12:02:00.000Z",
        done: false,
      },
    });
    expect((await entry.ticket())?.status).toBe("waiting");
    // The next check is not due before then.
    asked.length = 0;
    await scanMailjetStatus(new Date(now.getTime() + 60_000), answers(entry.providerId, "sent"));
    expect(asked).not.toContain(entry.providerId);
  });
  it("sends a failure to review and reopens the ticket, as a delivery report by mail does", async () => {
    const entry = await sentReply({ sentMinutesAgo: 3 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      (await scanMailjetStatus(now, answers(entry.providerId, "hardbounced", 1, true))).failed,
    ).toBe(1);
    expect(await entry.message()).toMatchObject({
      deliveryState: "review",
      source: {
        deliveryError: "bounced",
        bounce: {
          status: null,
          diagnostic: "Mailjet: hardbounced, state 1 (recipient)",
          via: "mailjet",
        },
        deliveryStatus: { status: "hardbounced", done: true, nextCheckAt: null },
      },
    });
    expect(await entry.ticket()).toMatchObject({ status: "open" });
    expect((await entry.ticket())?.pendingSince).not.toBeNull();
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("example.test");
    // A message that is in review is not asked about again.
    asked.length = 0;
    await scanMailjetStatus(new Date(now.getTime() + 3_600_000), answers(entry.providerId, "sent"));
    expect(asked).not.toContain(entry.providerId);
  });
  it("counts a message that Mailjet does not know yet, and ends after the last check", async () => {
    const entry = await sentReply({ sentMinutesAgo: 3 });
    await scanMailjetStatus(now, rejects(entry.providerId, "mailjet_status_not_found"));
    expect((await entry.message())?.source.deliveryStatus).toMatchObject({
      status: "not_found",
      checks: 1,
      done: false,
    });
    // The seventh check is the last: the delays of the plan are used up.
    const last = await sentReply({
      sentMinutesAgo: 3000,
      source: {
        deliveryStatus: { checks: 6, nextCheckAt: minutesAgo(1).toISOString(), done: false },
      },
    });
    await scanMailjetStatus(now, answers(last.providerId, "sent"));
    expect((await last.message())?.source.deliveryStatus).toMatchObject({
      checks: 7,
      nextCheckAt: null,
      done: true,
    });
  });
  it("leaves the message to the next pass when Mailjet cannot answer, and stops on a refused key", async () => {
    const unavailable = await sentReply({ sentMinutesAgo: 3 });
    await scanMailjetStatus(now, rejects(unavailable.providerId, "mailjet_status_unavailable"));
    expect((await unavailable.message())?.source.deliveryStatus).toBeUndefined();
    const refused = await sentReply({ sentMinutesAgo: 3 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await scanMailjetStatus(now, rejects(refused.providerId, "mailjet_auth_failed"));
    expect((await refused.message())?.source.deliveryStatus).toBeUndefined();
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "mailjet.status_stopped",
    );
  });
  it("leaves replies of other transports and messages after the window alone", async () => {
    const smtp = await sentReply({ transport: "smtp", sentMinutesAgo: 3 });
    const old = await sentReply({ sentMinutesAgo: 4 * 24 * 60 });
    // Only these two would be answered with a failure; whatever else is due in the shared database is not.
    const fetch = vi.fn((_secret: unknown, providerId: string) => {
      asked.push(providerId);
      return [smtp.providerId, old.providerId].includes(providerId)
        ? Promise.resolve({ status: "hardbounced", stateId: 1, permanent: true })
        : Promise.reject(new Error("mailjet_status_unavailable"));
    });
    await scanMailjetStatus(now, fetch);
    for (const entry of [smtp, old]) {
      expect(asked).not.toContain(entry.providerId);
      expect((await entry.message())?.deliveryState).toBe("sent");
      expect((await entry.message())?.source.deliveryStatus).toBeUndefined();
    }
  });
});
