import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  connections,
  jobs,
  memberships,
  notificationPreferences,
  notifications,
  projects,
  tickets,
  user,
} from "../src/server/db/schema";
import { emitEvent } from "../src/server/webhooks";
import { mailJob, setPreferences } from "../src/server/notifications";
import { runNotificationMail } from "../src/worker/notification-mail";
import { maxAttempts } from "../src/worker/claim";
import {
  cleanSubject,
  notificationMailMarkdown,
  notificationMailSubject,
  plainText,
} from "../src/domain/notification-mail";
import { startFakeSmtp, type FakeSmtp } from "./support/smtp";
import { initializeStorage } from "../src/server/storage";
import type { Action, Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectId = randomUUID();
const connectionId = randomUUID();
const worker = `mail-worker-${run}`;
const german = `mail-german-${run}`;
const people = [worker, german];
const replying: Action[] = ["project.read", "ticket.read", "ticket.reply"];
let smtp: FakeSmtp;
const principal = (id: string): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: replying }],
});
const ticket = async (subject = "Printer is on fire") => {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject,
      requesterEmail: "kim@customer.test",
      requesterName: "Kim Customer",
      language: "en",
    })
    .returning();
  if (!row) throw new Error("no ticket");
  return row;
};
const overdue = (row: { id: string; number: number | null }) =>
  db().transaction((tx) =>
    emitEvent(tx, projectId, "ticket.overdue", { ticketId: row.id, number: row.number }),
  );
const queued = () =>
  db()
    .select()
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), eq(jobs.type, mailJob)));
// The body of the mail as the wire holds it is quoted-printable: soft line breaks and the bytes of letters.
const decoded = (wire: string) => {
  const bytes: number[] = [];
  const text = wire.replace(/=\r?\n/g, "");
  for (let index = 0; index < text.length; index += 1) {
    const hex = /^[0-9A-F]{2}$/.test(text.slice(index + 1, index + 3))
      ? text.slice(index + 1, index + 3)
      : null;
    if (text[index] === "=" && hex) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else bytes.push(...Buffer.from(text[index] ?? "", "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
};
const drain = async () => {
  let rounds = 0;
  while (await runNotificationMail({ projectId })) rounds += 1;
  return rounds;
};
// Both people get the "overdue" rule when nobody is assigned (everybody who may reply).
const reset = async (settings: Record<string, unknown> = {}) => {
  smtp.messages.length = 0;
  smtp.behaviour = {};
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(notifications).where(inArray(notifications.userId, people));
  await db().delete(notificationPreferences).where(inArray(notificationPreferences.userId, people));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db()
    .update(projects)
    .set({ settings: { outboundConnectionId: connectionId, ...settings } })
    .where(eq(projects.id, projectId));
  await db().update(connections).set({ status: "ready" }).where(eq(connections.id, connectionId));
  await db().update(user).set({ active: true }).where(inArray(user.id, people));
};
beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEV_BOOTSTRAP", "true");
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  smtp = await startFakeSmtp();
  await db()
    .insert(projects)
    .values({
      id: projectId,
      name: "Mail Notify",
      slug: `mailnotify-${run}`,
      defaultLanguage: "en",
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
    .values([
      { id: worker, name: "Worker", email: `${worker}@example.test`, emailVerified: true },
      {
        id: german,
        name: "Deutsch",
        email: `${german}@example.test`,
        emailVerified: true,
        locale: "de",
      },
    ]);
  await db()
    .insert(memberships)
    .values(people.map((id) => ({ userId: id, projectId, actions: replying })));
}, 60_000);
beforeEach(() => reset());
afterAll(async () => {
  vi.unstubAllEnvs();
  await smtp.close();
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(audit).where(inArray(audit.actorId, people));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await db().delete(user).where(inArray(user.id, people));
  await sqlClient().end();
});
describe("the text of the mail", () => {
  it("names the kind, the number and the subject, writes a hostile subject as plain text, and keeps the header on one line", () => {
    const values = {
      project: "Support\r\nBcc: spy@example.test",
      number: 12,
      subject: "[Pay now](http://evil.test) *bold* <b>x</b>\r\nBcc: spy@example.test",
      url: "https://desk.example.test/?ticket=abc",
    };
    const subject = notificationMailSubject("en", "overdue", values);
    expect(subject).toBe(
      "[Support Bcc: spy@example.test] Overdue: #12 [Pay now](http://evil.test) *bold* <b>x</b> Bcc: spy@example.test",
    );
    expect(subject).not.toMatch(/[\r\n]/);
    const body = notificationMailMarkdown("de", "mention", values);
    expect(body).toContain("**Du wurdest erwähnt**");
    expect(body).toContain("(https://desk.example.test/?ticket=abc)");
    expect(body).toContain("\\[Pay now\\]\\(http://evil\\.test\\) \\*bold\\* \\<b\\>x\\</b\\>");
    expect(body.match(/\]\(/g)).toHaveLength(1);
    expect(cleanSubject("a b\u0007c   d")).toBe("a b c d");
    expect(cleanSubject("x".repeat(500))).toHaveLength(150);
    expect(plainText("a_b")).toBe("a\\_b");
  });
});
describe("the mail of a notification", () => {
  it("goes to the person with the link to the ticket and with nothing of the customer, as an automatic mail", async () => {
    const row = await ticket();
    await overdue(row);
    expect(await queued()).toHaveLength(2);
    expect(await drain()).toBe(2);
    expect(smtp.messages).toHaveLength(2);
    const wires = decoded(smtp.messages.join("\n=====\n"));
    expect(wires).toContain(`To: ${worker}@example.test`);
    expect(wires).toContain(`To: ${german}@example.test`);
    expect(wires).toContain("Subject: [Mail Notify] Overdue: #");
    expect(wires).toContain("Printer is on fire");
    expect(wires).toContain(`ticket=${row.id}`);
    expect(wires).toContain("Auto-Submitted: auto-replied");
    // The German operator gets German text; the customer is not named.
    expect(wires).toContain("Überfällig");
    expect(wires).not.toContain("kim@customer.test");
    expect(wires).not.toContain("Kim Customer");
    for (const job of await queued()) expect(job.status).toBe("succeeded");
    expect(await drain()).toBe(0);
    expect(smtp.messages).toHaveLength(2);
  });
  it("is not queued for a person who switched the mail off, and the desk gets its notification all the same", async () => {
    await setPreferences(principal(worker), {
      preferences: [{ kind: "overdue", desk: true, mail: false }],
    });
    await overdue(await ticket());
    expect((await queued()).map((job) => job.payload.userId)).toEqual([german]);
    expect(
      await db().select().from(notifications).where(eq(notifications.userId, worker)),
    ).toHaveLength(1);
    await drain();
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toContain(`To: ${german}@example.test`);
  });
  it("is sent without a notification in the desk when only the desk is switched off", async () => {
    await setPreferences(principal(worker), {
      preferences: [{ kind: "overdue", desk: false, mail: true }],
    });
    await overdue(await ticket());
    expect(
      await db().select().from(notifications).where(eq(notifications.userId, worker)),
    ).toHaveLength(0);
    await drain();
    expect(decoded(smtp.messages.join("\n"))).toContain(`To: ${worker}@example.test`);
  });
  it("is not queued when the project has no ready outgoing connection or pauses its mail", async () => {
    for (const change of [
      () =>
        db()
          .update(connections)
          .set({ status: "disabled" })
          .where(eq(connections.id, connectionId)),
      () =>
        db()
          .update(projects)
          .set({ settings: { pauseOutgoing: true, outboundConnectionId: connectionId } })
          .where(eq(projects.id, projectId)),
      () => db().update(projects).set({ settings: {} }).where(eq(projects.id, projectId)),
    ]) {
      await reset();
      await change();
      await overdue(await ticket());
      expect(await queued()).toHaveLength(0);
      // The desk is told in every case.
      expect(
        await db().select().from(notifications).where(inArray(notifications.userId, people)),
      ).toHaveLength(2);
    }
  });
  it("is not sent when it was queued and then no longer fits: paused, not ready, person gone or without rights, mail off, ticket gone", async () => {
    const cases: [string, () => Promise<unknown>][] = [
      [
        "paused",
        () =>
          db()
            .update(projects)
            .set({ settings: { pauseOutgoing: true, outboundConnectionId: connectionId } })
            .where(eq(projects.id, projectId)),
      ],
      [
        "not_ready",
        () =>
          db()
            .update(connections)
            .set({ status: "disabled" })
            .where(eq(connections.id, connectionId)),
      ],
      ["operator", () => db().update(user).set({ active: false }).where(inArray(user.id, people))],
      [
        "no_rights",
        () =>
          db()
            .update(memberships)
            .set({ actions: ["project.read"] })
            .where(inArray(memberships.userId, people)),
      ],
      [
        "switched_off",
        () =>
          db()
            .insert(notificationPreferences)
            .values(people.map((id) => ({ userId: id, kind: "overdue", desk: true, mail: false }))),
      ],
      ["ticket", () => db().delete(tickets).where(eq(tickets.projectId, projectId))],
    ];
    for (const [reason, change] of cases) {
      await reset();
      await overdue(await ticket());
      expect(await queued()).toHaveLength(2);
      await change();
      expect(await drain(), reason).toBe(2);
      expect(smtp.messages, reason).toHaveLength(0);
      expect(
        (await queued()).every((job) => job.status === "succeeded"),
        reason,
      ).toBe(true);
      await db()
        .update(memberships)
        .set({ actions: replying })
        .where(inArray(memberships.userId, people));
    }
  });
  it("is tried again after a failure of the transport and goes to review after the last try", async () => {
    await overdue(await ticket());
    const before = smtp.messages.length;
    smtp.behaviour = { data: "451 try again later" };
    await runNotificationMail({ projectId });
    await runNotificationMail({ projectId });
    const first = await queued();
    expect(first.map((job) => job.status).sort()).toEqual(["queued", "queued"]);
    expect(
      first.every((job) => job.attempts === 1 && job.lastErrorCode === "transport_failed"),
    ).toBe(true);
    expect(first.every((job) => job.runAfter.getTime() > Date.now())).toBe(true);
    for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
      await db().update(jobs).set({ runAfter: new Date() }).where(eq(jobs.projectId, projectId));
      await drain();
    }
    expect(
      (await queued()).every((job) => job.status === "review" && job.attempts === maxAttempts),
    ).toBe(true);
    // Once the transport works again nothing is sent late: a job in review is not run.
    smtp.behaviour = {};
    const attempted = smtp.messages.length;
    expect(await drain()).toBe(0);
    expect(smtp.messages).toHaveLength(attempted);
    expect(attempted).toBeGreaterThanOrEqual(before);
  });
  it("is not sent for a ticket of another project", async () => {
    const other = randomUUID();
    await db()
      .insert(projects)
      .values({ id: other, name: "Other", slug: `mailother-${run}` });
    try {
      const [foreign] = await db()
        .insert(tickets)
        .values({
          projectId: other,
          subject: "Not yours",
          requesterEmail: "kim@customer.test",
          requesterName: "Kim",
          language: "en",
        })
        .returning();
      await db()
        .insert(jobs)
        .values({
          projectId,
          type: mailJob,
          dedupKey: `foreign-${run}`,
          payload: { userId: worker, kind: "overdue", ticketId: foreign?.id },
        });
      expect(await drain()).toBe(1);
      expect(smtp.messages).toHaveLength(0);
      expect((await queued())[0]?.status).toBe("succeeded");
    } finally {
      await db().delete(tickets).where(eq(tickets.projectId, other));
      await db().delete(projects).where(eq(projects.id, other));
    }
  });
  it("leaves a job without a readable payload as finished", async () => {
    await db()
      .insert(jobs)
      .values({ projectId, type: mailJob, dedupKey: `bad-${run}`, payload: { nothing: true } });
    expect(await drain()).toBe(1);
    expect((await queued())[0]?.status).toBe("succeeded");
    expect(smtp.messages).toHaveLength(0);
    await db().execute(sql`select 1`);
  });
});
