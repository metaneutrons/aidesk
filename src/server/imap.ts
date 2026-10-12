import { ImapFlow } from "imapflow";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { connections, ingress, syncCursors } from "./db/schema";
import { unseal } from "./crypto";
import { env } from "./env";
import { acceptInbound } from "./inbound";
const imapConfig = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().min(1),
  mailbox: z.string().min(1).default("INBOX"),
  // Folder for junk; when absent, the server's \\Junk folder is used.
  junkMailbox: z.string().min(1).optional(),
  developmentOnly: z.boolean().default(false),
});
export interface PollResult {
  accepted: number;
  duplicates: number;
  uidValidityChanged: boolean;
}
// Reads new messages of one inbound IMAP connection into the inbound core.
// The cursor advances only after each message is durably accepted, so a
// crash re-reads at most the message in flight, which the core deduplicates.
// Loads an inbound IMAP connection, enforces its transport rules and connects.
async function openConnection(connectionId: string) {
  const [connection] = await db()
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.kind, "imap"),
        eq(connections.direction, "inbound"),
      ),
    );
  if (!connection) throw new Error("imap_connection_missing");
  const config = imapConfig.parse(connection.config);
  const development =
    process.env.NODE_ENV === "development" && process.env.DEV_BOOTSTRAP === "true";
  if (config.developmentOnly && !development) throw new Error("development_connection_not_allowed");
  if (!config.developmentOnly && !config.secure) throw new Error("imap_tls_required");
  if (!connection.secretCiphertext) throw new Error("imap_secret_missing");
  const secret = z
    .object({ pass: z.string().min(1) })
    .parse(JSON.parse(unseal(connection.secretCiphertext, env().ENCRYPTION_KEY)));
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: secret.pass },
    logger: false,
    disableAutoIdle: true,
    tls: { rejectUnauthorized: true },
  });
  await client.connect();
  return { connection, config, client };
}
export async function pollImapConnection(connectionId: string): Promise<PollResult> {
  const { connection, config, client } = await openConnection(connectionId);
  const result: PollResult = { accepted: 0, duplicates: 0, uidValidityChanged: false };
  try {
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      const opened = client.mailbox;
      if (!opened) throw new Error("imap_mailbox_unavailable");
      const uidValidity = String(opened.uidValidity);
      const [cursor] = await db()
        .select()
        .from(syncCursors)
        .where(eq(syncCursors.connectionId, connection.id));
      result.uidValidityChanged =
        cursor !== undefined &&
        (cursor.uidValidity !== uidValidity || cursor.mailbox !== config.mailbox);
      let lastUid = cursor && !result.uidValidityChanged ? cursor.lastUid : 0;
      const save = (uid: number) =>
        db()
          .insert(syncCursors)
          .values({
            connectionId: connection.id,
            mailbox: config.mailbox,
            uidValidity,
            lastUid: uid,
          })
          .onConflictDoUpdate({
            target: syncCursors.connectionId,
            set: { mailbox: config.mailbox, uidValidity, lastUid: uid, updatedAt: new Date() },
          });
      if (!cursor || result.uidValidityChanged) await save(lastUid);
      if (opened.exists > 0)
        for await (const message of client.fetch(
          `${String(lastUid + 1)}:*`,
          { uid: true, source: true },
          { uid: true },
        )) {
          // "n:*" also returns the newest message when no newer one exists.
          if (message.uid <= lastUid || !message.source) continue;
          const accepted = await acceptInbound({
            projectId: connection.projectId,
            connectionId: connection.id,
            externalKey: `imap:${connection.id}:${uidValidity}:${String(message.uid)}`,
            raw: message.source,
            origin: { kind: "imap", mailbox: config.mailbox, uidValidity, uid: message.uid },
          });
          if (accepted.duplicate) result.duplicates += 1;
          else result.accepted += 1;
          lastUid = message.uid;
          await save(lastUid);
        }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return result;
}

const imapLocation = z.object({
  mailbox: z.string().min(1),
  uidValidity: z.string().min(1),
  uid: z.number().int().positive(),
});
const imapOrigin = imapLocation.extend({
  kind: z.literal("imap"),
  location: imapLocation.optional(),
});
export type JunkSyncResult = "moved" | "in_place";
// Puts the original of an IMAP mail where aidesk's decision says it belongs:
// in the mailbox's junk folder while the mail is junk, back in the polled
// mailbox once restored. The job carries no direction, so a late or repeated
// run cannot undo a newer decision.
//
// A run that moved the message but failed before recording it finds the
// message again by its Message-ID. A message moved back to the polled mailbox
// gets a new UID; its external key is recorded as an alias in the same step,
// so the next poll does not read it again.
export async function syncImapJunk(ingressId: string): Promise<JunkSyncResult> {
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  if (!entry?.connectionId) throw new Error("ingress_missing");
  const origin = imapOrigin.parse(entry.origin);
  const location = origin.location ?? origin;
  const { connection, config, client } = await openConnection(entry.connectionId);
  try {
    let target = origin.mailbox;
    if (entry.state === "junk") {
      const junk =
        config.junkMailbox ??
        (await client.list()).find((mailbox) => mailbox.specialUse === "\\Junk")?.path;
      if (!junk) throw new Error("imap_junk_mailbox_missing");
      target = junk;
    }
    if (location.mailbox === target) return "in_place";
    const targetStatus = await client.status(target, { uidValidity: true }).catch(() => {
      throw new Error("imap_junk_mailbox_missing");
    });
    if (!targetStatus) throw new Error("imap_junk_mailbox_missing");
    const targetValidity = String(targetStatus.uidValidity ?? "");
    let newUid: number | undefined;
    const source = await client.getMailboxLock(location.mailbox);
    try {
      if (String(client.mailbox && client.mailbox.uidValidity) !== location.uidValidity)
        throw new Error("imap_uidvalidity_changed");
      const moved = await client.messageMove(String(location.uid), target, { uid: true });
      newUid = moved ? moved.uidMap?.get(location.uid) : undefined;
    } finally {
      source.release();
    }
    if (newUid === undefined) {
      // Moved in an earlier run, or the server reports no UID mapping.
      const messageId = entry.parsed?.messageId;
      if (typeof messageId !== "string") throw new Error("imap_message_missing");
      const lock = await client.getMailboxLock(target);
      try {
        const found = await client.search({ header: { "message-id": messageId } }, { uid: true });
        newUid = Array.isArray(found) ? found.at(-1) : undefined;
      } finally {
        lock.release();
      }
      if (newUid === undefined) throw new Error("imap_message_missing");
    }
    const next = { mailbox: target, uidValidity: targetValidity, uid: newUid };
    await db().transaction(async (tx) => {
      if (target === config.mailbox)
        await tx
          .insert(ingress)
          .values({
            projectId: entry.projectId,
            connectionId: connection.id,
            externalKey: `imap:${connection.id}:${targetValidity}:${String(newUid)}`,
            rawObjectKey: entry.rawObjectKey,
            checksum: entry.checksum,
            state: "alias",
            origin: { kind: "imap", aliasOf: entry.id, ...next },
          })
          .onConflictDoNothing({ target: ingress.externalKey });
      await tx
        .update(ingress)
        .set({ origin: { ...origin, location: next } })
        .where(eq(ingress.id, entry.id));
    });
    return "moved";
  } finally {
    await client.logout().catch(() => undefined);
  }
}
