import { ImapFlow } from "imapflow";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { connections, syncCursors } from "./db/schema";
import { unseal } from "./crypto";
import { env } from "./env";
import { acceptInbound } from "./inbound";
const imapConfig = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().min(1),
  mailbox: z.string().min(1).default("INBOX"),
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
export async function pollImapConnection(connectionId: string): Promise<PollResult> {
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
