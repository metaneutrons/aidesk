import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { SMTPServer, type SMTPServerSession } from "smtp-server";
import { db } from "./db";
import { connections, projects } from "./db/schema";
import { smtpInboundConfig } from "../domain/connections";
import { acceptInbound, maxRawBytes } from "./inbound";
import { sourceAllowed } from "./inbound-push";
// The SMTP receiver of the product: it takes mail for the addresses of the inbound connections of kind
// smtp and sends none. It has no login. Whoever connects can name any address, so the receiver
// answers for an address only when a connection that is ready names it, and it is narrow by design:
// no AUTH, no relay, no VRFY, a message limit, a limit of connections for everyone and for one
// address. The message is stored as it came; the receiver adds no header to it.
//
// A message is answered 250 only after the inbound core has committed it. A failure on our side is
// answered 451, so the sender keeps the message and tries again; a repeat is the same message and
// is taken once (the key is the checksum of the bytes, which is unique within a project).
export interface ReceiverOptions {
  host?: string | undefined;
  port: number;
  // The files of the certificate that STARTTLS uses; without them the receiver does not offer STARTTLS.
  tlsKeyFile?: string | undefined;
  tlsCertFile?: string | undefined;
  // The name in the greeting.
  name?: string | undefined;
  maxMessageBytes?: number;
  maxClients?: number;
  maxClientsPerAddress?: number;
}
export interface RunningReceiver {
  port: number;
  close: () => Promise<void>;
}
interface Target {
  connectionId: string;
  projectId: string;
}
type Refusal = "unknown" | "source" | "tls" | "archived";
// The connections that take mail for an address, and why there are none.
export async function resolveRecipient(
  address: string,
  source: string | null,
  secure: boolean,
): Promise<{ targets: Target[]; refusal: Refusal | null }> {
  const rows = await db()
    .select({
      id: connections.id,
      projectId: connections.projectId,
      config: connections.config,
      archivedAt: projects.archivedAt,
    })
    .from(connections)
    .innerJoin(projects, eq(projects.id, connections.projectId))
    .where(
      and(
        eq(connections.kind, "smtp"),
        eq(connections.direction, "inbound"),
        eq(connections.status, "ready"),
      ),
    );
  const wanted = address.toLowerCase();
  const targets: Target[] = [];
  let refusal: Refusal | null = null;
  for (const row of rows) {
    const config = smtpInboundConfig.safeParse(row.config);
    if (!config.success || !config.data.addresses.some((entry) => entry.toLowerCase() === wanted))
      continue;
    if (row.archivedAt) refusal ??= "archived";
    else if (!sourceAllowed(config.data.allowedSources, source)) refusal ??= "source";
    else if (config.data.requireTls && !secure) refusal ??= "tls";
    else targets.push({ connectionId: row.id, projectId: row.projectId });
  }
  if (targets.length > 0) return { targets, refusal: null };
  return { targets, refusal: refusal ?? "unknown" };
}
const replies: Record<Refusal, { code: number; text: string }> = {
  // A source that is not allowed and an unknown address answer alike: nobody learns which addresses exist.
  unknown: { code: 550, text: "5.1.1 Mailbox unavailable" },
  source: { code: 550, text: "5.1.1 Mailbox unavailable" },
  tls: { code: 530, text: "5.7.0 Must issue a STARTTLS command first" },
  archived: { code: 450, text: "4.2.1 Mailbox temporarily unavailable" },
};
function failure(code: number, text: string): Error {
  return Object.assign(new Error(text), { responseCode: code });
}
const log = (event: string, detail: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ event, ...detail }));
};
export function startReceiver(options: ReceiverOptions): Promise<RunningReceiver> {
  const limit = options.maxMessageBytes ?? maxRawBytes;
  const perAddress = options.maxClientsPerAddress ?? 10;
  // The addresses that a session wrote to, and the sessions that are counted for their address.
  const recipients = new Map<string, Map<string, Target[]>>();
  const counted = new Map<string, string>();
  const perRemote = new Map<string, number>();
  const server = new SMTPServer({
    name: options.name ?? "aidesk",
    banner: "aidesk mail receiver",
    authOptional: true,
    disabledCommands: ["AUTH"],
    hideSTARTTLS: !options.tlsKeyFile || !options.tlsCertFile,
    ...(options.tlsKeyFile && options.tlsCertFile
      ? { key: readFileSync(options.tlsKeyFile), cert: readFileSync(options.tlsCertFile) }
      : {}),
    size: limit,
    maxClients: options.maxClients ?? 50,
    socketTimeout: 60_000,
    closeTimeout: 5_000,
    logger: false,
    onConnect(session, callback) {
      const remote = session.remoteAddress;
      const open = perRemote.get(remote) ?? 0;
      if (open >= perAddress) {
        log("smtp_in.refused", { reason: "connections" });
        callback(failure(421, "4.7.0 Too many connections"));
        return;
      }
      perRemote.set(remote, open + 1);
      counted.set(session.id, remote);
      callback();
    },
    onClose(session) {
      recipients.delete(session.id);
      const remote = counted.get(session.id);
      if (remote === undefined) return;
      counted.delete(session.id);
      const open = (perRemote.get(remote) ?? 1) - 1;
      if (open <= 0) perRemote.delete(remote);
      else perRemote.set(remote, open);
    },
    onRcptTo(address, session, callback) {
      resolveRecipient(address.address, session.remoteAddress, session.secure)
        .then(({ targets, refusal }) => {
          if (refusal) {
            log("smtp_in.refused", { reason: refusal });
            const reply = replies[refusal];
            callback(failure(reply.code, reply.text));
            return;
          }
          const known = recipients.get(session.id) ?? new Map<string, Target[]>();
          known.set(address.address.toLowerCase(), targets);
          recipients.set(session.id, known);
          callback();
        })
        .catch(() => {
          callback(failure(451, "4.3.0 Local error, try again later"));
        });
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", () => {
        callback(failure(451, "4.3.0 Local error, try again later"));
      });
      stream.on("end", () => {
        if ((stream as unknown as { sizeExceeded?: boolean }).sizeExceeded) {
          log("smtp_in.refused", { reason: "size" });
          callback(failure(552, "5.3.4 Message size exceeds the limit"));
          return;
        }
        const raw = Buffer.concat(chunks);
        void deliver(session, raw).then(
          () => {
            callback(null, "2.0.0 Message accepted");
          },
          (error: unknown) => {
            log("smtp_in.failed", {
              code: error instanceof Error ? error.message.slice(0, 64) : "failed",
            });
            callback(failure(451, "4.3.0 Local error, try again later"));
          },
        );
      });
    },
  });
  // A message goes to each project once, even when it is addressed to two connections of the project: the
  // key is the checksum, and the key is unique within a project.
  async function deliver(session: SMTPServerSession, raw: Buffer): Promise<void> {
    const named = recipients.get(session.id) ?? new Map<string, Target[]>();
    const byProject = new Map<string, { target: Target; to: string[] }>();
    for (const [address, targets] of named)
      for (const target of targets) {
        const entry = byProject.get(target.projectId) ?? { target, to: [] };
        entry.to.push(address);
        byProject.set(target.projectId, entry);
      }
    if (byProject.size === 0) throw new Error("no_recipient");
    const checksum = createHash("sha256").update(raw).digest("hex");
    const sender = session.envelope.mailFrom;
    for (const { target, to } of byProject.values()) {
      const accepted = await acceptInbound({
        projectId: target.projectId,
        connectionId: target.connectionId,
        externalKey: `smtp:${checksum}`,
        raw,
        origin: {
          transport: "smtp",
          envelopeFrom: sender ? sender.address : null,
          recipients: to,
        },
      });
      log("smtp_in.accepted", {
        connectionId: target.connectionId,
        duplicate: accepted.duplicate,
        bytes: raw.length,
      });
    }
  }
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      const address = server.server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : options.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
