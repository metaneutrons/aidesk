import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../server/db";
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
import { emailTemplateVersion, renderEmail } from "../server/email";
import { activeEmailDesign, designForVersion, sampleMarkdown } from "../server/email-design";
import { portalLinkForMail, portalUrl } from "../server/portal";
import { activeTexts } from "../server/texts";
// The project's own wording of the link line, if it set one.
const ownLine = (text: string | undefined) => (text === undefined ? {} : { portalLinkLine: text });
import { threadHeaders } from "../domain/threading";
import { runIdempotentJob } from "../server/jobs";
import { pollImapConnection } from "../server/imap";
import { pollCloudflareConnection } from "../server/cloudflare";
import { deliver } from "./transport";
const payloadSchema = z.object({
  ticketId: z.uuid(),
  messageId: z.uuid(),
  connectionId: z.uuid(),
  actorId: z.string(),
  actorKind: z.enum(["human", "agent", "system"]),
  expectedRevision: z.number().int(),
  resolve: z.boolean(),
});
// Records why a reply went to review on the message itself, so every surface
// that shows the message can show the reason.
function deliveryError(code: string) {
  return sql`${messages.source} || ${JSON.stringify({ deliveryError: code })}::jsonb`;
}
// Refusals that happen before anything is handed to a transport. Their codes
// are kept for the review; any other error stays the general code, so that
// internal details never reach the stored reason.
const refusalCodes = new Set([
  "stale_or_paused_dispatch",
  "dispatch_grant_revoked",
  "acknowledgement_not_enabled",
  "autonomous_dispatch_not_enabled",
  "outbound_not_ready",
  "development_connection_not_allowed",
  "smtp_tls_required",
]);
// A scope limits the run to one project, which lets tests share a database.
export async function runNext(scope?: { projectId: string }): Promise<boolean> {
  const inScope = scope ? eq(jobs.projectId, scope.projectId) : undefined;
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
          inScope,
        ),
      )
      .returning();
    for (const entry of expired) {
      const messageId = z.uuid().safeParse(entry.payload.messageId);
      if (messageId.success)
        await tx
          .update(messages)
          .set({ deliveryState: "review", source: deliveryError("expired_dispatch_lease") })
          .where(eq(messages.id, messageId.data));
    }
  });
  const leaseToken = randomUUID();
  const job = await db().transaction(async (tx) => {
    const [due] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "queued"),
          eq(jobs.type, "mail.send"),
          sql`${jobs.runAfter} <= now()`,
          inScope,
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
      // An acknowledgement does not depend on the ticket's later changes.
      (payload.actorKind !== "system" && ticket.revision !== payload.expectedRevision) ||
      ticket.junkAt !== null ||
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
    } else if (payload.actorKind === "system") {
      // Only acknowledgements are sent without a person or agent, and only
      // while the project still has them enabled.
      if (message.source.kind !== "acknowledgement" || project.settings.acknowledgements !== true)
        throw new Error("acknowledgement_not_enabled");
    } else {
      const [agent] = await db().select().from(agents).where(eq(agents.id, payload.actorId));
      if (
        !agent?.active ||
        agent.projectId !== job.projectId ||
        agent.expiresAt <= new Date() ||
        !agent.actions.includes("ticket.reply") ||
        (payload.resolve && !agent.actions.includes("ticket.resolve")) ||
        ticket.assigneeAgentId !== agent.id ||
        project.settings.approvalPolicy !== "direct" ||
        project.settings.stopAutonomous === true
      )
        throw new Error("autonomous_dispatch_not_enabled");
    }
    if (connection.status !== "ready") throw new Error("outbound_not_ready");
    const automatic = payload.actorKind === "system";
    const design = await activeEmailDesign(project.id, project.settings);
    // A project may add a link to the ticket page; it is the same for every mail
    // about the ticket, and a revoked grant yields none.
    const token = project.settings.portalLinks === true ? await portalLinkForMail(ticket.id) : null;
    const link = token ? portalUrl(token) : null;
    const content = await renderEmail({
      project: project.name,
      markdown: message.markdown,
      language: message.language,
      color: project.color,
      fallbackLanguage: project.defaultLanguage,
      ...(design ? { design: design.config } : {}),
      ...(link ? { portalUrl: link } : {}),
      ...(link ? ownLine((await activeTexts(project.id, message.language)).portalLink) : {}),
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
    const subject = `Re: ${ticket.subject}`;
    const { outgoingId, sender } = await deliver({
      jobId: job.id,
      project,
      connection,
      localId: message.id,
      to: ticket.requesterEmail,
      subject,
      thread,
      content,
      ticketId: ticket.id,
      automatic,
      report: (reported) => {
        code = reported;
      },
    });
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
        .set({
          deliveryState: "sent",
          source: {
            ...message.source,
            messageId: outgoingId,
            // What was handed to the transport, kept as sent: later changes to
            // the ticket, the template or the project do not alter it.
            sent: {
              at: new Date().toISOString(),
              transport: connection.kind,
              to: ticket.requesterEmail,
              ...sender,
              subject,
              language: message.language,
              templateVersion: emailTemplateVersion,
              designVersion: design?.version ?? 0,
              markdown: message.markdown,
              // The link is a credential: the record keeps the mail without it.
              portalLink: link !== null,
              html: link ? content.html.replaceAll(link, "{portal-link}") : content.html,
              text: link ? content.text.replaceAll(link, "{portal-link}") : content.text,
            },
          },
        })
        .where(eq(messages.id, message.id));
      // A newer inbound revision retains its response obligation. An
      // acknowledgement is not an answer and leaves the ticket unchanged.
      if (!automatic)
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
  } catch (error) {
    if (
      code === "dispatch_needs_review" &&
      error instanceof Error &&
      refusalCodes.has(error.message)
    )
      code = error.message;
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
          .set({ deliveryState: "review", source: deliveryError(code) })
          .where(eq(messages.id, failed.payload.messageId));
    });
    console.log(JSON.stringify({ event: "mail.review", jobId: job.id, code }));
  }
  return true;
}
const testPayload = z.object({
  userId: z.string(),
  to: z.email(),
  connectionId: z.uuid(),
  language: z.enum(["en", "de"]),
  version: z.number().int().min(0).optional(),
});
// Test mails of a design (see sendTestMail). They use the same transport path
// as replies but belong to no ticket and message. An expired dispatch may have
// reached the transport and is not replayed.
export async function runTestSend(scope?: { projectId: string }): Promise<boolean> {
  const inScope = scope ? eq(jobs.projectId, scope.projectId) : undefined;
  await db()
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
        eq(jobs.type, "mail.test"),
        sql`${jobs.leaseUntil} < now()`,
        inScope,
      ),
    );
  const leaseToken = randomUUID();
  const job = await db().transaction(async (tx) => {
    const [due] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "queued"),
          eq(jobs.type, "mail.test"),
          sql`${jobs.runAfter} <= now()`,
          inScope,
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
  let code = "dispatch_needs_review";
  try {
    const payload = testPayload.parse(job.payload);
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
      !project ||
      !connection ||
      project.settings.pauseOutgoing === true ||
      project.settings.outboundConnectionId !== connection.id
    )
      throw new Error("stale_or_paused_dispatch");
    const [operator] = await db().select().from(user).where(eq(user.id, payload.userId));
    const [grant] = await db()
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, payload.userId), eq(memberships.projectId, job.projectId)));
    if (!operator?.active || !grant?.actions.includes("project.manage"))
      throw new Error("dispatch_grant_revoked");
    if (connection.status !== "ready") throw new Error("outbound_not_ready");
    const chosen = await designForVersion(project.id, project.settings, payload.version);
    const content = await renderEmail({
      project: project.name,
      markdown: sampleMarkdown(payload.language),
      language: payload.language,
      color: project.color,
      fallbackLanguage: project.defaultLanguage,
      ...(chosen.config ? { design: chosen.config } : {}),
    });
    await deliver({
      jobId: job.id,
      project,
      connection,
      localId: job.id,
      to: payload.to,
      subject: `[Test] ${project.name}, design version ${String(chosen.version)}`,
      thread: {},
      content,
      ticketId: job.id,
      automatic: false,
      report: (reported) => {
        code = reported;
      },
    });
    const done = await db()
      .update(jobs)
      .set({ status: "succeeded", leaseUntil: null, updatedAt: new Date() })
      .where(and(eq(jobs.id, job.id), eq(jobs.leaseToken, leaseToken), eq(jobs.status, "running")))
      .returning({ id: jobs.id });
    if (!done.length) throw new Error("dispatch_lease_lost");
    console.log(JSON.stringify({ event: "mail.test_accepted", jobId: job.id }));
  } catch (error) {
    if (
      code === "dispatch_needs_review" &&
      error instanceof Error &&
      refusalCodes.has(error.message)
    )
      code = error.message;
    await db()
      .update(jobs)
      .set({ status: "review", lastErrorCode: code, leaseUntil: null, updatedAt: new Date() })
      .where(and(eq(jobs.id, job.id), eq(jobs.leaseToken, leaseToken), eq(jobs.status, "running")));
    console.log(JSON.stringify({ event: "mail.test_review", jobId: job.id, code }));
  }
  return true;
}
export async function runIngest(): Promise<boolean> {
  const ran = await runIdempotentJob();
  if (ran) console.log(JSON.stringify({ event: `${ran.type}.ran`, outcome: ran.outcome }));
  return ran !== null;
}
// Inbound mailboxes and Cloudflare buckets are polled; degraded connections
// keep being tried so they recover on their own, and each result updates the
// connection status.
const imapPollMs = Math.max(5, Number(process.env.IMAP_POLL_SECONDS) || 60) * 1000;
let nextImapPoll = 0;
export async function pollMailboxes(): Promise<void> {
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
