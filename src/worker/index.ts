import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import { z } from "zod";
import { db, sqlClient } from "../server/db";
import {
  agents,
  connections,
  jobs,
  memberships,
  messages,
  projects,
  tickets,
  user,
} from "../server/db/schema";
import { renderEmail } from "../server/email";
import { unseal } from "../server/crypto";
import { env } from "../server/env";
import { threadHeaders } from "../domain/threading";
import { processIngress } from "../server/inbound";
import { pollImapConnection } from "../server/imap";
import {
  parseCloudflareOutbound,
  pollCloudflareConnection,
  sendViaCloudflare,
} from "../server/cloudflare";
const payloadSchema = z.object({
  ticketId: z.uuid(),
  messageId: z.uuid(),
  connectionId: z.uuid(),
  actorId: z.string(),
  actorKind: z.enum(["human", "agent"]),
  expectedRevision: z.number().int(),
  resolve: z.boolean(),
});
const smtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  from: z.email(),
  replyTo: z.email(),
  developmentOnly: z.boolean().default(false),
});
const lifecycle = { stopped: false };
process.on("SIGTERM", () => {
  lifecycle.stopped = true;
});
process.on("SIGINT", () => {
  lifecycle.stopped = true;
});
async function runNext(): Promise<boolean> {
  // An expired dispatch may have reached the transport. Never replay it blindly.
  await db().transaction(async (tx) => {
    const expired = await tx
      .update(jobs)
      .set({
        status: "review",
        lastErrorCode: "expired_dispatch_lease",
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.status, "running"),
          eq(jobs.type, "mail.send"),
          sql`${jobs.leaseUntil} < now()`,
        ),
      )
      .returning();
    for (const entry of expired) {
      const messageId = z.uuid().safeParse(entry.payload.messageId);
      if (messageId.success)
        await tx
          .update(messages)
          .set({ deliveryState: "review" })
          .where(eq(messages.id, messageId.data));
    }
  });
  const leaseToken = randomUUID();
  const job = await db().transaction(async (tx) => {
    const [due] = await tx
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.status, "queued"), eq(jobs.type, "mail.send"), sql`${jobs.runAfter} <= now()`),
      )
      .orderBy(jobs.runAfter)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!due) return null;
    const [claimed] = await tx
      .update(jobs)
      .set({
        status: "running",
        leaseToken,
        leaseUntil: new Date(Date.now() + 120_000),
        attempts: due.attempts + 1,
      })
      .where(eq(jobs.id, due.id))
      .returning();
    return claimed ?? null;
  });
  if (!job) return false;
  let code = "dispatch_needs_review";
  try {
    const payload = payloadSchema.parse(job.payload);
    const [ticket] = await db()
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, payload.ticketId), eq(tickets.projectId, job.projectId)));
    const [message] = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.id, payload.messageId), eq(messages.ticketId, payload.ticketId)));
    const [project] = await db().select().from(projects).where(eq(projects.id, job.projectId));
    const [connection] = await db()
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, payload.connectionId),
          eq(connections.projectId, job.projectId),
          eq(connections.direction, "outbound"),
        ),
      );
    if (
      !ticket ||
      !message ||
      message.internal ||
      !project ||
      !connection ||
      ticket.revision !== payload.expectedRevision ||
      project.settings.pauseOutgoing === true ||
      project.settings.outboundConnectionId !== connection.id
    )
      throw new Error("stale_or_paused_dispatch");
    if (payload.actorKind === "human") {
      const [operator] = await db().select().from(user).where(eq(user.id, payload.actorId));
      const [grant] = await db()
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.userId, payload.actorId), eq(memberships.projectId, job.projectId)),
        );
      if (
        !operator?.active ||
        !grant?.actions.includes("ticket.reply") ||
        (payload.resolve && !grant.actions.includes("ticket.resolve"))
      )
        throw new Error("dispatch_grant_revoked");
    } else {
      const [agent] = await db().select().from(agents).where(eq(agents.id, payload.actorId));
      if (
        !agent?.active ||
        agent.projectId !== job.projectId ||
        agent.expiresAt <= new Date() ||
        !agent.actions.includes("ticket.reply") ||
        (payload.resolve && !agent.actions.includes("ticket.resolve")) ||
        ticket.assigneeAgentId !== agent.id ||
        project.settings.aiMode !== "autonomous" ||
        project.settings.stopAutonomous === true
      )
        throw new Error("autonomous_dispatch_not_enabled");
    }
    if (connection.status !== "ready") throw new Error("outbound_not_ready");
    const content = await renderEmail({
      project: project.name,
      markdown: message.markdown,
      language: message.language,
      color: project.color,
    });
    const earlier = await db()
      .select({
        authorType: messages.authorType,
        receivedMessageId: messages.receivedMessageId,
        deliveryState: messages.deliveryState,
        source: messages.source,
      })
      .from(messages)
      .where(
        and(
          eq(messages.ticketId, ticket.id),
          eq(messages.internal, false),
          lt(messages.createdAt, message.createdAt),
        ),
      )
      .orderBy(messages.createdAt);
    const thread = threadHeaders(
      earlier.map((entry) =>
        entry.authorType === "customer"
          ? { messageId: entry.receivedMessageId, fromCustomer: true }
          : {
              messageId: entry.deliveryState === "sent" ? entry.source.messageId : null,
              fromCustomer: false,
            },
      ),
    );
    let outgoingId: string | null;
    if (connection.kind === "cloudflare") {
      const { config, secret } = parseCloudflareOutbound(
        connection.config,
        connection.secretCiphertext,
      );
      code = "transport_acceptance_unknown";
      try {
        const sent = await sendViaCloudflare(config, secret, {
          fromName: project.name,
          to: ticket.requesterEmail,
          subject: `Re: ${ticket.subject}`,
          ...thread,
          ...content,
          ticketId: ticket.id,
        });
        outgoingId = sent.messageId;
      } catch (error) {
        if (error instanceof Error && error.message === "transport_rejected") code = error.message;
        throw error;
      }
    } else if (connection.kind === "smtp") {
      const config = smtpSchema.parse(connection.config);
      if (
        config.developmentOnly &&
        (process.env.NODE_ENV !== "development" || process.env.DEV_BOOTSTRAP !== "true")
      )
        throw new Error("development_connection_not_allowed");
      const secret = connection.secretCiphertext
        ? z
            .object({ user: z.string(), pass: z.string() })
            .parse(JSON.parse(unseal(connection.secretCiphertext, env().ENCRYPTION_KEY)))
        : undefined;
      if (!config.developmentOnly && !config.secure && config.port !== 587)
        throw new Error("smtp_tls_required");
      const transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        requireTLS: !config.developmentOnly && !config.secure,
        auth: secret,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      });
      code = "transport_acceptance_unknown";
      const senderDomain = config.from.slice(config.from.lastIndexOf("@") + 1);
      outgoingId = `<${message.id}@${senderDomain}>`;
      const accepted = await transport.sendMail({
        from: { name: project.name, address: config.from },
        replyTo: config.replyTo,
        to: ticket.requesterEmail,
        subject: `Re: ${ticket.subject}`,
        messageId: outgoingId,
        ...thread,
        headers: { "X-Aidesk-Ticket": ticket.id },
        ...content,
      });
      if (!accepted.accepted.map(String).includes(ticket.requesterEmail))
        throw new Error("recipient_not_accepted");
    } else throw new Error("outbound_not_ready");
    await db().transaction(async (tx) => {
      const [owned] = await tx
        .select()
        .from(jobs)
        .where(
          and(eq(jobs.id, job.id), eq(jobs.leaseToken, leaseToken), eq(jobs.status, "running")),
        )
        .for("update");
      if (!owned) throw new Error("dispatch_lease_lost");
      await tx
        .update(messages)
        .set({ deliveryState: "sent", source: { ...message.source, messageId: outgoingId } })
        .where(eq(messages.id, message.id));
      // A newer inbound revision retains its response obligation.
      await tx
        .update(tickets)
        .set({
          pendingSince: null,
          status: payload.resolve ? "resolved" : "waiting",
          resolvedAt: payload.resolve ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(and(eq(tickets.id, ticket.id), eq(tickets.revision, payload.expectedRevision)));
      await tx
        .update(jobs)
        .set({ status: "succeeded", leaseUntil: null, updatedAt: new Date() })
        .where(eq(jobs.id, job.id));
    });
    console.log(JSON.stringify({ event: "mail.accepted", jobId: job.id }));
  } catch {
    await db().transaction(async (tx) => {
      const [failed] = await tx
        .update(jobs)
        .set({ status: "review", lastErrorCode: code, leaseUntil: null, updatedAt: new Date() })
        .where(
          and(eq(jobs.id, job.id), eq(jobs.leaseToken, leaseToken), eq(jobs.status, "running")),
        )
        .returning();
      if (failed && typeof failed.payload.messageId === "string")
        await tx
          .update(messages)
          .set({ deliveryState: "review" })
          .where(eq(messages.id, failed.payload.messageId));
    });
    console.log(JSON.stringify({ event: "mail.review", jobId: job.id, code }));
  }
  return true;
}
// Inbound processing is idempotent, so a lost lease is simply requeued and
// transient failures retry with backoff: at most six attempts in about a day.
const ingestBackoffMinutes = [1, 5, 30, 120, 360, 1440];
async function runIngest(): Promise<boolean> {
  await db()
    .update(jobs)
    .set({ status: "retry", leaseUntil: null, updatedAt: new Date() })
    .where(
      and(
        eq(jobs.status, "running"),
        eq(jobs.type, "mail.ingest"),
        sql`${jobs.leaseUntil} < now()`,
      ),
    );
  const leaseToken = randomUUID();
  const job = await db().transaction(async (tx) => {
    const [due] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          inArray(jobs.status, ["queued", "retry"]),
          eq(jobs.type, "mail.ingest"),
          sql`${jobs.runAfter} <= now()`,
        ),
      )
      .orderBy(jobs.runAfter)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!due) return null;
    const [claimed] = await tx
      .update(jobs)
      .set({
        status: "running",
        leaseToken,
        leaseUntil: new Date(Date.now() + 120_000),
        attempts: due.attempts + 1,
      })
      .where(eq(jobs.id, due.id))
      .returning();
    return claimed ?? null;
  });
  if (!job) return false;
  const owned = and(eq(jobs.id, job.id), eq(jobs.leaseToken, leaseToken));
  try {
    const outcome = await processIngress(z.uuid().parse(job.payload.ingressId));
    await db()
      .update(jobs)
      .set({ status: "succeeded", leaseUntil: null, updatedAt: new Date() })
      .where(owned);
    console.log(JSON.stringify({ event: "mail.ingested", jobId: job.id, outcome }));
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 64) : "ingest_failed";
    const permanent = code === "inbound_sender_missing" || code === "ingress_missing";
    const delay = ingestBackoffMinutes[job.attempts - 1];
    await db()
      .update(jobs)
      .set(
        permanent || delay === undefined || job.attempts >= ingestBackoffMinutes.length
          ? { status: "review", lastErrorCode: code, leaseUntil: null, updatedAt: new Date() }
          : {
              status: "retry",
              lastErrorCode: code,
              leaseUntil: null,
              runAfter: new Date(Date.now() + delay * 60_000 * (0.8 + Math.random() * 0.4)),
              updatedAt: new Date(),
            },
      )
      .where(owned);
    console.log(JSON.stringify({ event: "mail.ingest_failed", jobId: job.id, code }));
  }
  return true;
}
// Inbound mailboxes and Cloudflare buckets are polled; degraded connections
// keep being tried so they recover on their own, and each result updates the
// connection status.
const imapPollMs = Math.max(5, Number(process.env.IMAP_POLL_SECONDS) || 60) * 1000;
let nextImapPoll = 0;
async function pollMailboxes(): Promise<void> {
  if (Date.now() < nextImapPoll) return;
  nextImapPoll = Date.now() + imapPollMs;
  const inbound = await db()
    .select({ id: connections.id, kind: connections.kind })
    .from(connections)
    .where(
      and(
        inArray(connections.kind, ["imap", "cloudflare"]),
        eq(connections.direction, "inbound"),
        inArray(connections.status, ["ready", "degraded"]),
      ),
    );
  for (const connection of inbound) {
    try {
      const result =
        connection.kind === "imap"
          ? await pollImapConnection(connection.id)
          : await pollCloudflareConnection(connection.id);
      await db()
        .update(connections)
        .set({ status: "ready", lastErrorCode: null, updatedAt: new Date() })
        .where(eq(connections.id, connection.id));
      if (Object.values(result).some(Boolean))
        console.log(
          JSON.stringify({
            event: `${connection.kind}.polled`,
            connectionId: connection.id,
            ...result,
          }),
        );
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 64) : "poll_failed";
      await db()
        .update(connections)
        .set({ status: "degraded", lastErrorCode: code, updatedAt: new Date() })
        .where(eq(connections.id, connection.id));
      console.log(
        JSON.stringify({ event: `${connection.kind}.failed`, connectionId: connection.id, code }),
      );
    }
  }
}
console.log(JSON.stringify({ event: "worker.ready" }));
while (!lifecycle.stopped) {
  try {
    await pollMailboxes();
    const ingested = await runIngest();
    const sent = await runNext();
    if (!ingested && !sent) await delay(1000);
  } catch {
    console.log(JSON.stringify({ event: "worker.database_unavailable" }));
    await delay(3000);
  }
}
await sqlClient().end();
