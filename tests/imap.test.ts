import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  connections,
  ingress,
  jobs,
  projects,
  syncCursors,
  tickets,
} from "../src/server/db/schema";
import { pollImapConnection, syncImapJunk } from "../src/server/imap";
import { simpleParser } from "mailparser";
import { processIngress } from "../src/server/inbound";
import { runIdempotentJob } from "../src/server/jobs";
import { listJunk, restoreJunkMail } from "../src/server/operations";
import type { Principal } from "../src/domain/permissions";
import { getObject, initializeStorage } from "../src/server/storage";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
// Against the development GreenMail server (SMTP 3025, IMAP 3143), which
// accepts any password and creates mailboxes on demand.
const host = process.env.DEV_IMAP_HOST ?? "127.0.0.1";
const projectId = randomUUID();
const user = `imap-${projectId}@support.local`;
async function connection(config: Record<string, unknown>, secret = true) {
  const [created] = await db()
    .insert(connections)
    .values({
      projectId,
      kind: "imap",
      name: "Test mailbox",
      direction: "inbound",
      status: "ready",
      config: { host, port: 3143, secure: false, user, developmentOnly: true, ...config },
      secretCiphertext: secret
        ? seal(JSON.stringify({ pass: "test" }), env().ENCRYPTION_KEY)
        : null,
    })
    .returning({ id: connections.id });
  return created?.id ?? "";
}
function message(subject: string) {
  return [
    "From: Customer <customer@example.test>",
    `To: ${user}`,
    `Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@example.test>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Body of ${subject}`,
    "",
  ].join("\r\n");
}
async function mailbox<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host,
    port: 3143,
    secure: false,
    auth: { user, pass: "test" },
    logger: false,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.logout();
  }
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values({ id: projectId, name: "IMAP test", slug: `imap-${projectId}` });
});
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEV_BOOTSTRAP", "true");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(ingress).where(eq(ingress.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(connections).where(eq(connections.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await sqlClient().end();
});
describe("IMAP adapter", () => {
  it("reads delivered mail once and keeps its position", async () => {
    const id = await connection({ mailbox: "INBOX" });
    const subject = `IMAP ${randomUUID()}`;
    await nodemailer
      .createTransport({ host, port: 3025, secure: false, ignoreTLS: true })
      .sendMail({ envelope: { from: "customer@example.test", to: user }, raw: message(subject) });
    expect(await pollImapConnection(id)).toMatchObject({ accepted: 1, uidValidityChanged: false });
    expect(await pollImapConnection(id)).toMatchObject({ accepted: 0, duplicates: 0 });
    const [cursor] = await db().select().from(syncCursors).where(eq(syncCursors.connectionId, id));
    expect(cursor).toMatchObject({ mailbox: "INBOX", lastUid: 1 });
    const [entry] = await db().select().from(ingress).where(eq(ingress.connectionId, id));
    expect(entry?.externalKey).toBe(`imap:${id}:${cursor?.uidValidity ?? ""}:1`);
    expect(await processIngress(entry?.id ?? "")).toBe("created");
    const [processed] = await db()
      .select()
      .from(ingress)
      .where(eq(ingress.id, entry?.id ?? ""));
    const [ticket] = await db()
      .select()
      .from(tickets)
      .where(eq(tickets.id, processed?.ticketId ?? ""));
    expect(ticket?.subject).toBe(subject);
  });
  it("rereads after a UIDVALIDITY change without duplicating messages", async () => {
    const folder = `uv-${randomUUID().slice(0, 8)}`;
    const id = await connection({ mailbox: folder });
    const raw = message(`Validity ${randomUUID()}`);
    await mailbox(async (client) => {
      await client.mailboxCreate(folder);
      await client.append(folder, raw);
    });
    expect(await pollImapConnection(id)).toMatchObject({ accepted: 1, uidValidityChanged: false });
    await mailbox(async (client) => {
      await client.mailboxDelete(folder);
      // GreenMail derives UIDVALIDITY from the clock in seconds; recreating in
      // the same second would reuse it, which RFC 3501 servers must not do.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await client.mailboxCreate(folder);
      await client.append(folder, raw);
    });
    const reread = await pollImapConnection(id);
    expect(reread).toMatchObject({ accepted: 1, uidValidityChanged: true });
    const entries = await db().select().from(ingress).where(eq(ingress.connectionId, id));
    expect(entries).toHaveLength(2);
    const outcomes = [];
    for (const entry of entries.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime()))
      outcomes.push(await processIngress(entry.id));
    expect(outcomes).toEqual(["created", "duplicate"]);
  });
  it("refuses unsafe or unknown connections", async () => {
    const plain = await connection({ developmentOnly: false });
    await expect(pollImapConnection(plain)).rejects.toThrow("imap_tls_required");
    const development = await connection({});
    vi.stubEnv("NODE_ENV", "production");
    await expect(pollImapConnection(development)).rejects.toThrow(
      "development_connection_not_allowed",
    );
    await expect(pollImapConnection(randomUUID())).rejects.toThrow("imap_connection_missing");
    vi.stubEnv("NODE_ENV", "development");
    const unsecured = await connection({}, false);
    await expect(pollImapConnection(unsecured)).rejects.toThrow("imap_secret_missing");
    await db()
      .delete(connections)
      .where(inArray(connections.id, [plain, development, unsecured]));
  });
});
describe("IMAP junk folder", () => {
  const triager: Principal = {
    id: `triager-${projectId}`,
    kind: "human",
    active: true,
    owner: false,
    grants: [{ projectId, actions: ["project.read", "ticket.read", "ticket.junk"] }],
  };
  async function deliverSpam(subject: string) {
    const raw = message(subject).replace("MIME-Version", "X-Spam-Flag: YES\r\nMIME-Version");
    await nodemailer
      .createTransport({ host, port: 3025, secure: false, ignoreTLS: true })
      .sendMail({ envelope: { from: "customer@example.test", to: user }, raw });
  }
  // Polls until the mail with this subject has been read; delivery into the
  // mailbox can lag behind the SMTP answer under load.
  async function receive(id: string, subject: string) {
    await expect
      .poll(
        async () => {
          await pollImapConnection(id);
          return (await entryFor(id, subject)) !== undefined;
        },
        { timeout: 10_000, interval: 200 },
      )
      .toBe(true);
  }
  async function drain() {
    const outcomes: string[] = [];
    for (
      let ran = await runIdempotentJob({ projectId });
      ran;
      ran = await runIdempotentJob({ projectId })
    )
      outcomes.push(`${ran.type}:${ran.outcome}`);
    return outcomes;
  }
  async function find(folder: string, subject: string): Promise<number[]> {
    return mailbox(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const found = await client.search({ subject }, { uid: true });
        return Array.isArray(found) ? found : [];
      } finally {
        lock.release();
      }
    });
  }
  // Before processing, the subject is only in the stored original.
  async function entryFor(id: string, subject: string) {
    const entries = await db().select().from(ingress).where(eq(ingress.connectionId, id));
    for (const entry of entries) {
      const found =
        typeof entry.parsed?.subject === "string"
          ? entry.parsed.subject
          : (await simpleParser(await getObject(entry.rawObjectKey))).subject;
      if (found === subject && entry.state !== "alias") return entry;
    }
    return undefined;
  }
  it("moves junk into the junk folder and back without reading it twice", async () => {
    const junk = `Junk-${randomUUID().slice(0, 8)}`;
    await mailbox((client) => client.mailboxCreate(junk));
    const id = await connection({ mailbox: "INBOX", junkMailbox: junk });
    // Start after anything earlier tests left in the inbox.
    await pollImapConnection(id);
    const subject = `Spam ${randomUUID()}`;
    await deliverSpam(subject);
    await receive(id, subject);
    expect(await drain()).toEqual(
      expect.arrayContaining(["mail.ingest:junk", "mail.junk_sync:moved"]),
    );
    expect(await find("INBOX", subject)).toEqual([]);
    expect(await find(junk, subject)).toHaveLength(1);
    const entry = await entryFor(id, subject);
    expect(entry?.origin).toMatchObject({
      location: { mailbox: junk },
      junkSync: { state: "done" },
    });
    expect((await listJunk(triager)).find((item) => item.id === entry?.id)?.mailbox).toBe("done");
    // Restoring brings the original back to the inbox under a new UID.
    await restoreJunkMail(triager, entry?.id ?? "");
    expect(await drain()).toEqual(
      expect.arrayContaining(["mail.ingest:created", "mail.junk_sync:moved"]),
    );
    expect(await find(junk, subject)).toEqual([]);
    expect(await find("INBOX", subject)).toHaveLength(1);
    // The next poll recognises it as the restored mail, not as new junk.
    expect(await pollImapConnection(id)).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(await drain()).toEqual([]);
    const created = await db().select().from(tickets).where(eq(tickets.subject, subject));
    expect(created).toHaveLength(1);
  });
  it("retries a failed move and picks up an interrupted one", async () => {
    const junk = `Later-${randomUUID().slice(0, 8)}`;
    const id = await connection({ mailbox: "INBOX", junkMailbox: junk });
    await pollImapConnection(id);
    const subject = `Spam ${randomUUID()}`;
    await deliverSpam(subject);
    await receive(id, subject);
    // The junk folder does not exist yet: the move waits and says so.
    expect(await drain()).toEqual(
      expect.arrayContaining([
        "mail.ingest:junk",
        "mail.junk_sync:failed:imap_junk_mailbox_missing",
      ]),
    );
    const entry = await entryFor(id, subject);
    expect(entry?.origin).toMatchObject({ junkSync: { state: "retrying" } });
    const [waiting] = await db()
      .select()
      .from(jobs)
      .where(eq(jobs.dedupKey, `junk-sync:${entry?.id ?? ""}:junk`));
    expect(waiting).toMatchObject({ status: "retry", lastErrorCode: "imap_junk_mailbox_missing" });
    expect(await find("INBOX", subject)).toHaveLength(1);
    // The folder appears, and the message is moved there by hand before the
    // retry runs, as if the earlier run had moved it and then crashed. The
    // job was also left running when the worker stopped.
    await mailbox(async (client) => {
      await client.mailboxCreate(junk);
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = await client.search({ subject }, { uid: true });
        if (Array.isArray(uids)) await client.messageMove(uids, junk, { uid: true });
      } finally {
        lock.release();
      }
    });
    await db()
      .update(jobs)
      .set({ status: "running", leaseUntil: new Date(Date.now() - 1000), runAfter: new Date() })
      .where(eq(jobs.id, waiting?.id ?? ""));
    expect(await drain()).toEqual(["mail.junk_sync:moved"]);
    expect(await find(junk, subject)).toHaveLength(1);
    expect(await find("INBOX", subject)).toEqual([]);
    expect((await entryFor(id, subject))?.origin).toMatchObject({
      location: { mailbox: junk },
      junkSync: { state: "done" },
    });
  });
});
describe("idempotent job edge cases", () => {
  it("finds the junk folder by name, stays in place and stops on permanent errors", async () => {
    await mailbox(async (client) => {
      const existing = (await client.list()).some((entry) => entry.path === "Junk");
      if (!existing) await client.mailboxCreate("Junk");
    });
    const id = await connection({ mailbox: "INBOX" });
    await pollImapConnection(id);
    const subject = `Spam ${randomUUID()}`;
    const raw = message(subject).replace("MIME-Version", "X-Spam-Flag: YES\r\nMIME-Version");
    await nodemailer
      .createTransport({ host, port: 3025, secure: false, ignoreTLS: true })
      .sendMail({ envelope: { from: "customer@example.test", to: user }, raw });
    // Delivery into the mailbox can lag behind the SMTP answer under load.
    let entry: typeof ingress.$inferSelect | undefined;
    await expect
      .poll(
        async () => {
          await pollImapConnection(id);
          const entries = await db().select().from(ingress).where(eq(ingress.connectionId, id));
          for (const row of entries) {
            if (row.state !== "queued") continue;
            const parsed = await simpleParser(await getObject(row.rawObjectKey));
            if (parsed.subject === subject) entry = row;
          }
          return entry !== undefined;
        },
        { timeout: 10_000, interval: 200 },
      )
      .toBe(true);
    await processIngress(entry?.id ?? "");
    // Without a configured folder, the server's folder named Junk is used.
    expect(await syncImapJunk(entry?.id ?? "")).toBe("moved");
    expect(await syncImapJunk(entry?.id ?? "")).toBe("in_place");
    // A recorded location whose UIDVALIDITY no longer matches is not guessed at.
    const [moved] = await db()
      .select()
      .from(ingress)
      .where(eq(ingress.id, entry?.id ?? ""));
    await db()
      .update(ingress)
      .set({
        state: "queued",
        origin: { ...moved?.origin, location: { mailbox: "Junk", uidValidity: "1", uid: 1 } },
      })
      .where(eq(ingress.id, entry?.id ?? ""));
    await expect(syncImapJunk(entry?.id ?? "")).rejects.toThrow("imap_uidvalidity_changed");
    await expect(syncImapJunk(randomUUID())).rejects.toThrow("ingress_missing");
    // The runner sends permanent failures, broken payloads and exhausted
    // retries to review instead of retrying them.
    const base = { projectId, type: "mail.junk_sync", status: "queued" as const };
    const [permanentFailure, broken, exhausted] = await db()
      .insert(jobs)
      .values([
        { ...base, dedupKey: `edge:${randomUUID()}`, payload: { ingressId: entry?.id ?? "" } },
        { ...base, dedupKey: `edge:${randomUUID()}`, payload: { ingressId: "not-a-uuid" } },
        {
          ...base,
          type: "mail.ingest",
          dedupKey: `edge:${randomUUID()}`,
          payload: { ingressId: randomUUID() },
          attempts: 6,
        },
      ])
      .returning({ id: jobs.id });
    for (
      let ran = await runIdempotentJob({ projectId });
      ran;
      ran = await runIdempotentJob({ projectId })
    );
    const states = await db()
      .select({ id: jobs.id, status: jobs.status, code: jobs.lastErrorCode })
      .from(jobs)
      .where(inArray(jobs.id, [permanentFailure?.id ?? "", broken?.id ?? "", exhausted?.id ?? ""]));
    expect(
      states
        .map(({ status, code }) => ({ status, code }))
        .sort((a, b) => (a.code ?? "").localeCompare(b.code ?? "")),
    ).toEqual([
      { status: "review", code: "imap_uidvalidity_changed" },
      { status: "review", code: "ingress_missing" },
      { status: "review", code: "ingress_missing" },
    ]);
  });
});
