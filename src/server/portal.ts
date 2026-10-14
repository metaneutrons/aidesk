import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { audit, messages, participants, projects, tickets } from "./db/schema";
import { detectLanguage } from "../domain/language";
import { DomainError } from "./errors";
import { emitEvent } from "./webhooks";
import { markdownHtml } from "./markdown";
import { getTicket } from "./operations";
import { env } from "./env";
import { permits, type Principal } from "../domain/permissions";
// Portal grants give the requester of one ticket read access to that ticket's
// public conversation. A link is derived, not stored: the identifier of the
// participant plus a MAC over that identifier and the participant's epoch, made
// with a key derived from the encryption key. So every mail about the ticket
// can carry the same link, a database copy does not contain any link, and a
// new link (a higher epoch) replaces the earlier one. A grant also expires and
// can be revoked. Changing the encryption key ends all links.
const defaultDays = 30;
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
export const portalLinkInput = z.object({
  days: z.number().int().min(1).max(90).default(defaultDays),
});
// Issues a new link for the ticket's requester and invalidates an earlier one.
// The link is returned once and can be derived again by the server for mail.
export async function issuePortalGrant(
  principal: Principal,
  ticketId: string,
  input: unknown = {},
) {
  const { days } = portalLinkInput.parse(input);
  const ticket = await manageable(principal, ticketId);
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
  return { token, expiresAt };
}
// The link for mail about a ticket, for the worker. A requester who was never
// given one gets a grant now; a grant that ran out is renewed, because the mail
// goes to the requester anyway; a revoked grant stays revoked and yields no
// link. The epoch is not raised, so links in earlier mail keep working.
export async function portalLinkForMail(ticketId: string): Promise<string | null> {
  const [ticket] = await db().select().from(tickets).where(eq(tickets.id, ticketId));
  if (ticket?.junkAt !== null) return null;
  const email = ticket.requesterEmail.toLowerCase();
  const expiresAt = new Date(Date.now() + defaultDays * 86_400_000);
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
export async function resolvePortalGrant(token: unknown) {
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
export async function getPortalTicket(token: unknown) {
  const grant = await resolvePortalGrant(token);
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
export async function portalReply(token: unknown, input: unknown) {
  const values = z
    .object({ markdown: z.string().trim().min(1).max(20_000), idempotencyKey: z.uuid() })
    .strict()
    .parse(input);
  const grant = await resolvePortalGrant(token);
  if (!grant) throw new DomainError("not_found", 404);
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
    return { id: message.id, duplicate: false };
  });
}

// The address of a link, on the application's public origin.
export function portalUrl(token: string): string {
  return `${new URL(env().APP_URL).origin}/portal/${token}`;
}
