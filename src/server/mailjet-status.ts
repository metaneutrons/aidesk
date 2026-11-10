import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { db } from "./db";
import { connections, messages, projects, tickets } from "./db/schema";
import {
  firstCheckDelayMs,
  interpretStatus,
  nextCheckAt,
  type MailjetMessageStatus,
} from "../domain/mailjet-status";
import { recordBounce } from "./delivery-failure";
import { fetchMailjetStatus, parseMailjetOutbound, type MailjetSecret } from "./mailjet";
// Replies that went out through Mailjet are asked about in the API of Mailjet, so a failure that the
// recipient's server reports after it accepted the mail shows on the message and reopens the ticket, as a
// delivery report by mail does. Nothing calls the product: no webhook and no open address are needed.
const window = 3 * 24 * 3_600_000;
const batch = 25;
interface Tracked {
  checks?: number;
  nextCheckAt?: string | null;
  done?: boolean;
}
export interface MailjetScan {
  checked: number;
  failed: number;
}
type Fetch = (secret: MailjetSecret, providerId: string) => Promise<MailjetMessageStatus>;
// The keys of a project: the connection that it sends through, or else any Mailjet connection of it.
async function secretOf(projectId: string): Promise<MailjetSecret | null> {
  const [project] = await db()
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, projectId));
  const rows = await db()
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.projectId, projectId),
        eq(connections.kind, "mailjet"),
        eq(connections.direction, "outbound"),
        ne(connections.status, "disabled"),
      ),
    )
    .orderBy(asc(connections.createdAt));
  const row = rows.find((entry) => entry.id === project?.settings.outboundConnectionId) ?? rows[0];
  if (!row) return null;
  try {
    return parseMailjetOutbound(row.config, row.secretCiphertext).secret;
  } catch {
    return null;
  }
}
export async function scanMailjetStatus(
  now = new Date(),
  fetchStatus: Fetch = fetchMailjetStatus,
): Promise<MailjetScan> {
  const result: MailjetScan = { checked: 0, failed: 0 };
  const candidates = await db()
    .select({ message: messages, ticket: tickets })
    .from(messages)
    .innerJoin(tickets, eq(tickets.id, messages.ticketId))
    .where(
      and(
        eq(messages.deliveryState, "sent"),
        sql`${messages.source}->'sent'->>'transport' = 'mailjet'`,
        sql`${messages.source}->'sent'->>'providerId' is not null`,
        sql`coalesce(${messages.source}->'deliveryStatus'->>'done', 'false') <> 'true'`,
        gt(messages.createdAt, new Date(now.getTime() - window)),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(200);
  const due = candidates
    .filter(({ message }) => {
      const state = (message.source.deliveryStatus ?? {}) as Tracked;
      const sentAt = new Date(String((message.source.sent as { at?: string } | undefined)?.at));
      const at = state.nextCheckAt
        ? new Date(state.nextCheckAt)
        : new Date(sentAt.getTime() + firstCheckDelayMs);
      return !Number.isNaN(at.getTime()) && at <= now;
    })
    .slice(0, batch);
  const secrets = new Map<string, MailjetSecret | null>();
  for (const { message, ticket } of due) {
    if (!secrets.has(ticket.projectId))
      secrets.set(ticket.projectId, await secretOf(ticket.projectId));
    const secret = secrets.get(ticket.projectId);
    if (!secret) continue;
    const providerId = String((message.source.sent as { providerId?: string }).providerId);
    const checks = ((message.source.deliveryStatus ?? {}) as Tracked).checks ?? 0;
    let status: MailjetMessageStatus | null = null;
    try {
      status = await fetchStatus(secret, providerId);
    } catch (error) {
      const code = error instanceof Error ? error.message : "mailjet_status_unavailable";
      // A key that is refused or a limit of the API ends the pass; other failures wait for the next one.
      if (code === "mailjet_auth_failed" || code === "mailjet_rate_limited") {
        console.log(JSON.stringify({ event: "mailjet.status_stopped", code }));
        break;
      }
      if (code !== "mailjet_status_not_found") continue;
    }
    const outcome = status ? interpretStatus(status) : ({ kind: "pending" } as const);
    const next = outcome.kind === "failed" ? null : nextCheckAt(checks, now);
    const tracked = {
      provider: "mailjet",
      status: status?.status ?? "not_found",
      stateId: status?.stateId ?? null,
      checks: checks + 1,
      checkedAt: now.toISOString(),
      nextCheckAt: next?.toISOString() ?? null,
      done: next === null,
    };
    const recorded = await db().transaction(async (tx) => {
      const [current] = await tx
        .select({ message: messages, ticket: tickets })
        .from(messages)
        .innerJoin(tickets, eq(tickets.id, messages.ticketId))
        .where(eq(messages.id, message.id))
        .for("update", { of: [messages, tickets] });
      if (!current) return false;
      const seen = (current.message.source.deliveryStatus ?? {}) as Tracked;
      // Another pass or a delivery report by mail has dealt with the message in the meantime.
      if (current.message.deliveryState !== "sent" || (seen.checks ?? 0) !== checks) return false;
      if (outcome.kind === "failed")
        await recordBounce(tx, current, {
          status: null,
          diagnostic: outcome.diagnostic,
          at: now,
          via: "mailjet",
        });
      // Merged into what is stored, so that no other change of the source is lost.
      await tx
        .update(messages)
        .set({
          source: sql`${messages.source} || ${JSON.stringify({ deliveryStatus: tracked })}::jsonb`,
        })
        .where(eq(messages.id, message.id));
      return true;
    });
    if (!recorded) continue;
    result.checked += 1;
    if (outcome.kind === "failed") {
      result.failed += 1;
      console.log(JSON.stringify({ event: "mailjet.bounced", messageId: message.id }));
    }
  }
  return result;
}
