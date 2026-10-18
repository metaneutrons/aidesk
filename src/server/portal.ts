import { queueAgentRun } from "./agent-runs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  attachments,
  audit,
  messages,
  participants,
  projects,
  tickets,
  translations,
} from "./db/schema";
import { attachmentRefusal, safeFilename } from "../domain/attachments";
import { putObject } from "./storage";
import { detectLanguage } from "../domain/language";
import { DomainError } from "./errors";
import { emitEvent } from "./webhooks";
import { markdownHtml } from "./markdown";
import { getTicket } from "./operations";
import { env } from "./env";
import { fileRules, portalRules } from "../domain/limits";
import { getLimits } from "./limits";
import { hostServesProject, portalBase, type PortalHost } from "./portal-domains";
import { permits, type Principal } from "../domain/permissions";
// Portal grants give the requester of one ticket read access to that ticket's
// public conversation. A link is derived, not stored: the identifier of the
// participant plus a MAC over that identifier and the participant's epoch, made
// with a key derived from the encryption key. So every mail about the ticket
// can carry the same link, a database copy does not contain any link, and a
// new link (a higher epoch) replaces the earlier one. A grant also expires and
// can be revoked. Changing the encryption key ends all links.
const subkey = () =>
  createHmac("sha256", Buffer.from(env().ENCRYPTION_KEY, "hex"))
    .update("aidesk portal links v1")
    .digest();
const uuidBytes = (value: string) => Buffer.from(value.replaceAll("-", ""), "hex");
function mac(participantId: string, epoch: number): Buffer {
  return createHmac("sha256", subkey())
    .update(`portal:${participantId}:${String(epoch)}`)
    .digest();
}
function linkToken(participantId: string, epoch: number): string {
  return `${uuidBytes(participantId).toString("base64url")}.${mac(participantId, epoch).toString("base64url")}`;
}
// The participant id inside a token, or null when it is not shaped like one.
function participantOf(token: string): { id: string; mac: Buffer } | null {
  const match = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const idBytes = Buffer.from(match[1] ?? "", "base64url");
  const mac = Buffer.from(match[2] ?? "", "base64url");
  // Only the encoding that was issued is accepted. The last character of both
  // parts carries bits that the decoder ignores, so other spellings of the same
  // bytes exist; they are refused, so one link has exactly one spelling.
  if (idBytes.length !== 16 || idBytes.toString("base64url") !== match[1]) return null;
  if (mac.length !== 32 || mac.toString("base64url") !== match[2]) return null;
  const raw = idBytes.toString("hex");
  return {
    id: `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`,
    mac,
  };
}
async function manageable(principal: Principal, ticketId: string) {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
  const { ticket } = await getTicket(principal, ticketId);
  if (!permits(principal, ticket.projectId, "ticket.reply"))
    throw new DomainError("forbidden", 403);
  return ticket;
}
// Without `days` the link lasts what the owner set as the default (30 days until they change it).
export const portalLinkInput = z.object({ days: z.number().int().min(1).max(90).optional() });
// Issues a new link for the ticket's requester and invalidates an earlier one.
// The link is returned once and can be derived again by the server for mail.
export async function issuePortalGrant(
  principal: Principal,
  ticketId: string,
  input: unknown = {},
) {
  const asked = portalLinkInput.parse(input);
  const ticket = await manageable(principal, ticketId);
  const days = asked.days ?? (await getLimits()).portalLinkDays;
  if (ticket.junkAt !== null) throw new DomainError("conflict", 409);
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  const email = ticket.requesterEmail.toLowerCase();
  const token = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(participants)
      .values({
        ticketId: ticket.id,
        email,
        // The link goes to the address that wrote to us and that we answered.
        verified: true,
        grantExpiresAt: expiresAt,
      })
      .onConflictDoUpdate({
        target: [participants.ticketId, participants.email],
        set: {
          verified: true,
          grantExpiresAt: expiresAt,
          revokedAt: null,
          portalEpoch: sql`${participants.portalEpoch} + 1`,
        },
      })
      .returning({ id: participants.id, epoch: participants.portalEpoch });
    if (!row) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "portal.grant",
      targetId: ticket.id,
    });
    return linkToken(row.id, row.epoch);
  });
  return { token, expiresAt, projectId: ticket.projectId };
}
// The link for mail about a ticket, for the worker. A requester who was never
// given one gets a grant now; a grant that ran out is renewed, because the mail
// goes to the requester anyway; a revoked grant stays revoked and yields no
// link. The epoch is not raised, so links in earlier mail keep working.
export async function portalLinkForMail(ticketId: string): Promise<string | null> {
  const [ticket] = await db().select().from(tickets).where(eq(tickets.id, ticketId));
  if (ticket?.junkAt !== null) return null;
  const email = ticket.requesterEmail.toLowerCase();
  const expiresAt = new Date(Date.now() + (await getLimits()).portalLinkDays * 86_400_000);
  const [row] = await db()
    .insert(participants)
    .values({ ticketId: ticket.id, email, verified: true, grantExpiresAt: expiresAt })
    .onConflictDoUpdate({
      target: [participants.ticketId, participants.email],
      set: { grantExpiresAt: expiresAt },
      setWhere: sql`${participants.revokedAt} is null and ${participants.verified}`,
    })
    .returning({ id: participants.id, epoch: participants.portalEpoch });
  return row ? linkToken(row.id, row.epoch) : null;
}
export async function revokePortalGrant(principal: Principal, ticketId: string) {
  const ticket = await manageable(principal, ticketId);
  return db().transaction(async (tx) => {
    const revoked = await tx
      .update(participants)
      .set({ revokedAt: new Date() })
      .where(and(eq(participants.ticketId, ticket.id), isNull(participants.revokedAt)))
      .returning({ id: participants.id });
    if (!revoked.length) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "portal.revoke",
      targetId: ticket.id,
    });
    return { revoked: true };
  });
}
// The grant behind a token, or null for anything that is not a valid grant:
// malformed, forged, replaced by a newer link, revoked, expired, unverified, or
// for a ticket in junk.
// `host` is what the name of the request belongs to, when that is a name of a customer page: a link of another
// project does not open on the name of a project, and a link of a project with a name of its own does not open on
// the name of the installation.
export async function resolvePortalGrant(token: unknown, host: PortalHost | null = null) {
  if (typeof token !== "string" || token.length > 100) return null;
  const parsed = participantOf(token);
  if (!parsed) return null;
  const [grant] = await db()
    .select({
      participantId: participants.id,
      email: participants.email,
      epoch: participants.portalEpoch,
      ticketId: tickets.id,
      projectId: tickets.projectId,
    })
    .from(participants)
    .innerJoin(tickets, eq(tickets.id, participants.ticketId))
    .where(
      and(
        eq(participants.id, parsed.id),
        eq(participants.verified, true),
        isNull(participants.revokedAt),
        gt(participants.grantExpiresAt, sql`now()`),
        isNull(tickets.junkAt),
      ),
    );
  if (!grant) return null;
  const expected = mac(grant.participantId, grant.epoch);
  if (parsed.mac.length !== expected.length || !timingSafeEqual(parsed.mac, expected)) return null;
  if (!(await hostServesProject(host, grant.projectId))) return null;
  return {
    participantId: grant.participantId,
    email: grant.email,
    ticketId: grant.ticketId,
    projectId: grant.projectId,
  };
}
// What the holder of a token may see: the public conversation of that one
// ticket. Private notes, messages that were not delivered, staff addresses and
// everything else of the ticket stay out.
export async function getPortalTicket(
  token: unknown,
  language?: string,
  host: PortalHost | null = null,
) {
  const grant = await resolvePortalGrant(token, host);
  if (!grant) throw new DomainError("not_found", 404);
  const [row] = await db()
    .select({
      number: tickets.number,
      subject: tickets.subject,
      status: tickets.status,
      resolvedAt: tickets.resolvedAt,
      language: tickets.language,
      createdAt: tickets.createdAt,
      project: projects.name,
      projectId: projects.id,
    })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(eq(tickets.id, grant.ticketId));
  if (!row) throw new DomainError("not_found", 404);
  const conversation = await db()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.ticketId, grant.ticketId),
        eq(messages.internal, false),
        inArray(messages.deliveryState, ["received", "sent"]),
      ),
    )
    .orderBy(asc(messages.createdAt));
  const files = new Map<string, { filename: string; size: number }[]>();
  if (conversation.length > 0)
    for (const file of await db()
      .select({
        messageId: attachments.messageId,
        filename: attachments.filename,
        size: attachments.size,
        refusal: attachments.refusal,
      })
      .from(attachments)
      .where(
        inArray(
          attachments.messageId,
          conversation.map((message) => message.id),
        ),
      )
      .orderBy(attachments.messageId, attachments.position))
      if (!file.refusal) files.set(file.messageId, [...(files.get(file.messageId) ?? []), file]);
  // The translation of a message into the language of the page, when a person had one made and
  // the message has not changed since: shown as what it is, next to the message.
  const shown = new Map<string, string>();
  const target = language?.toLowerCase().split("-")[0];
  if (target && conversation.length > 0) {
    const ready = await db()
      .select()
      .from(translations)
      .where(
        and(
          inArray(
            translations.messageId,
            conversation.map((message) => message.id),
          ),
          eq(translations.language, target),
          eq(translations.status, "ready"),
        ),
      );
    for (const record of ready) {
      const message = conversation.find((entry) => entry.id === record.messageId);
      if (message?.revision === record.sourceRevision && record.markdown)
        shown.set(record.messageId, markdownHtml(record.markdown));
    }
  }
  return {
    projectId: row.projectId,
    ticket: {
      number: row.number,
      subject: row.subject,
      status: row.status,
      language: row.language,
      createdAt: row.createdAt,
    },
    canReply: repliesAllowed(row.status, row.resolvedAt),
    messages: conversation.map((message) => ({
      id: message.id,
      from: message.authorType === "customer" ? ("you" as const) : ("team" as const),
      authorName: message.authorType === "customer" ? message.authorName : row.project,
      markdown: message.markdown,
      html: markdownHtml(message.markdown),
      translation: shown.get(message.id) ?? null,
      // The names of the files that came with the message, for the customer's own overview; the
      // files themselves are not offered on this page.
      attachments: (files.get(message.id) ?? []).map((file) => ({
        filename: file.filename,
        size: file.size,
      })),
      createdAt: message.createdAt,
    })),
  };
}

// A resolved ticket can be answered for 30 days, like by mail; after that the
// customer starts a new request.
const reopenWindowMs = 30 * 86_400_000;
function repliesAllowed(status: string, resolvedAt: Date | null): boolean {
  if (status !== "resolved") return true;
  if (!resolvedAt) return false;
  return Date.now() - resolvedAt.getTime() <= reopenWindowMs;
}
const replyLimit = 20;
// A reply written in the portal by the holder of a token. It becomes a message
// of the requester like a mail would, reopens the ticket and starts the
// response obligation if there is none. The key makes a repeated submission
// harmless, and the number of replies per hour is limited.
// A file that a customer sends with a reply, as the form gave it.
export interface PortalFile {
  filename: string;
  contentType: string;
  content: Buffer;
}
// What a customer may send with one reply: the types and the size of one file that a received mail is
// held to, and a number of files and a total that are set for the portal (10 files and 30 MB together
// until an owner changes them). A file that is not accepted refuses the reply and says which rule it
// broke, so that nothing is kept that the customer did not mean to send.
export async function portalReply(
  token: unknown,
  input: unknown,
  files: PortalFile[] = [],
  host: PortalHost | null = null,
) {
  const values = z
    .object({ markdown: z.string().trim().min(1).max(20_000), idempotencyKey: z.uuid() })
    .strict()
    .parse(input);
  const grant = await resolvePortalGrant(token, host);
  if (!grant) throw new DomainError("not_found", 404);
  const limits = await getLimits();
  const portal = portalRules(limits);
  const rules = { maxCount: portal.count, maxBytes: fileRules(limits).maxBytes };
  const sent = files.map((file, index) => {
    const filename = safeFilename(file.filename, index);
    const contentType = (file.contentType || "application/octet-stream").toLowerCase();
    return {
      filename,
      contentType,
      size: file.content.length,
      checksum: createHash("sha256").update(file.content).digest("hex"),
      content: file.content,
      refusal: attachmentRefusal(
        { filename, contentType, size: file.content.length },
        index,
        rules,
      ),
    };
  });
  const refused = sent.find((file) => file.refusal)?.refusal;
  if (refused) throw new DomainError(refused, 422);
  if (sent.reduce((sum, file) => sum + file.size, 0) > portal.bytes)
    throw new DomainError("attachment_too_large", 422);
  // Stored before the transaction, like a received mail's files, under their checksum, and only
  // for a reply that the transaction may still refuse: storing the same file again is harmless.
  for (const file of sent)
    await putObject(
      `attachments/${grant.projectId}/${file.checksum}`,
      file.content,
      "application/octet-stream",
    );
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`portal:${grant.ticketId}`}))`);
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.id, grant.ticketId))
      .for("update");
    if (ticket?.junkAt !== null) throw new DomainError("not_found", 404);
    const [again] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.ticketId, ticket.id),
          sql`${messages.source}->>'idempotencyKey' = ${values.idempotencyKey}`,
        ),
      );
    if (again) return { id: again.id, duplicate: true };
    if (!repliesAllowed(ticket.status, ticket.resolvedAt)) throw new DomainError("conflict", 409);
    const [recent] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.ticketId, ticket.id),
          sql`${messages.source}->>'participantId' = ${grant.participantId}`,
          sql`${messages.createdAt} > now() - interval '1 hour'`,
        ),
      );
    if ((recent?.count ?? 0) >= replyLimit) throw new DomainError("rate_limited", 429);
    const detection = detectLanguage(values.markdown);
    const now = new Date();
    const [message] = await tx
      .insert(messages)
      .values({
        ticketId: ticket.id,
        authorType: "customer",
        authorName: ticket.requesterName,
        authorEmail: grant.email,
        markdown: values.markdown,
        language: detection.language ?? ticket.language,
        deliveryState: "received",
        source: {
          channel: "portal",
          participantId: grant.participantId,
          idempotencyKey: values.idempotencyKey,
          languageDetection: { language: detection.language, reason: detection.reason },
        },
        createdAt: now,
      })
      .returning({ id: messages.id });
    if (!message) throw new DomainError("conflict", 409);
    if (sent.length)
      await tx.insert(attachments).values(
        sent.map((file, position) => ({
          messageId: message.id,
          position,
          projectId: grant.projectId,
          filename: file.filename,
          contentType: file.contentType,
          size: file.size,
          checksum: file.checksum,
          objectKey: `attachments/${grant.projectId}/${file.checksum}`,
          inline: false,
          contentId: null,
          refusal: null,
        })),
      );
    await tx
      .update(tickets)
      .set({
        status: "open",
        resolvedAt: null,
        pendingSince: ticket.pendingSince ?? now,
        revision: sql`${tickets.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(tickets.id, ticket.id));
    await emitEvent(tx, ticket.projectId, "message.received", {
      ticketId: ticket.id,
      number: ticket.number,
      messageId: message.id,
      channel: "portal",
    });
    if (ticket.status !== "open")
      await emitEvent(tx, ticket.projectId, "ticket.status_changed", {
        ticketId: ticket.id,
        number: ticket.number,
        from: ticket.status,
        to: "open",
      });
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: `portal:${grant.participantId}`,
      action: "portal.reply",
      targetId: ticket.id,
    });
    // A managed agent that works the ticket answers the new message.
    await queueAgentRun(tx, ticket.id, "message");
    return { id: message.id, duplicate: false };
  });
}

// The address of a link: on a verified name of the project when it has one, otherwise on the application's
// public origin.
export async function portalUrl(token: string, projectId: string): Promise<string> {
  return `${await portalBase(projectId)}/portal/${token}`;
}
