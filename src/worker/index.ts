import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, lt, sql } from "drizzle-orm";
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
    if (connection.kind !== "smtp" || connection.status !== "ready")
      throw new Error("outbound_not_ready");
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
    code = "transport_acceptance_unknown";
    const senderDomain = config.from.slice(config.from.lastIndexOf("@") + 1);
    const outgoingId = `<${message.id}@${senderDomain}>`;
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
console.log(JSON.stringify({ event: "worker.ready" }));
while (!lifecycle.stopped) {
  try {
    if (!(await runNext())) await delay(1000);
  } catch {
    console.log(JSON.stringify({ event: "worker.database_unavailable" }));
    await delay(3000);
  }
}
await sqlClient().end();
