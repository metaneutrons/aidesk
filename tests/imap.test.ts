import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { db, sqlClient } from "../src/server/db";
import {
  connections,
  ingress,
  jobs,
  projects,
  syncCursors,
  tickets,
} from "../src/server/db/schema";
import { pollImapConnection } from "../src/server/imap";
import { processIngress } from "../src/server/inbound";
import { initializeStorage } from "../src/server/storage";
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
