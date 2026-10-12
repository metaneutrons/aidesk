import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { audit, messages, participants, projects, tickets } from "./db/schema";
import { DomainError } from "./errors";
import { markdownHtml } from "./markdown";
import { getTicket } from "./operations";
import { permits, type Principal } from "../domain/permissions";
// Portal grants give the requester of one ticket read access to that ticket's
// public conversation. A grant is a random token that is stored only as a
// hash, belongs to exactly one participant of one ticket, and can expire or be
// revoked. The surfaces (portal pages, REST) follow with M3; this is the model
// they use.
const defaultDays = 30;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
async function manageable(principal: Principal, ticketId: string) {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
  const { ticket } = await getTicket(principal, ticketId);
  if (!permits(principal, ticket.projectId, "ticket.reply"))
    throw new DomainError("forbidden", 403);
  return ticket;
}
// Issues a new token for the ticket's requester and invalidates an earlier one.
// The token is returned once; only its hash is kept.
export async function issuePortalGrant(
  principal: Principal,
  ticketId: string,
  input: unknown = {},
) {
  const { days } = z
    .object({ days: z.number().int().min(1).max(90).default(defaultDays) })
    .parse(input);
  const ticket = await manageable(principal, ticketId);
  if (ticket.junkAt !== null) throw new DomainError("conflict", 409);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  const email = ticket.requesterEmail.toLowerCase();
  await db().transaction(async (tx) => {
    await tx
      .insert(participants)
      .values({
        ticketId: ticket.id,
        email,
        // The token goes to the address that wrote to us and that we answered.
        verified: true,
        portalTokenHash: hash(token),
        grantExpiresAt: expiresAt,
      })
      .onConflictDoUpdate({
        target: [participants.ticketId, participants.email],
        set: {
          verified: true,
          portalTokenHash: hash(token),
          grantExpiresAt: expiresAt,
          revokedAt: null,
        },
      });
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "portal.grant",
      targetId: ticket.id,
    });
  });
  return { token, expiresAt };
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
// unknown, revoked, expired, unverified, or for a ticket in junk.
export async function resolvePortalGrant(token: unknown) {
  if (typeof token !== "string" || token.length < 40 || token.length > 100) return null;
  const [grant] = await db()
    .select({
      participantId: participants.id,
      email: participants.email,
      ticketId: tickets.id,
      projectId: tickets.projectId,
    })
    .from(participants)
    .innerJoin(tickets, eq(tickets.id, participants.ticketId))
    .where(
      and(
        eq(participants.portalTokenHash, hash(token)),
        eq(participants.verified, true),
        isNull(participants.revokedAt),
        gt(participants.grantExpiresAt, sql`now()`),
        isNull(tickets.junkAt),
      ),
    );
  return grant ?? null;
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
      language: tickets.language,
      createdAt: tickets.createdAt,
      project: projects.name,
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
  const { project, ...ticket } = row;
  return {
    ticket,
    messages: conversation.map((message) => ({
      id: message.id,
      from: message.authorType === "customer" ? ("you" as const) : ("team" as const),
      authorName: message.authorType === "customer" ? message.authorName : project,
      markdown: message.markdown,
      html: markdownHtml(message.markdown),
      createdAt: message.createdAt,
    })),
  };
}
