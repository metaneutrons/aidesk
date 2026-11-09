import { eq, sql } from "drizzle-orm";
import type { Tx } from "./changes";
import { messages, tickets } from "./db/schema";
// What a reply that did not arrive does to its message and its ticket. A delivery report that comes back
// by mail and a status that a provider reports through its API end here alike.
export interface Bounce {
  status: string | null;
  diagnostic: string | null;
  at: Date;
  // Where the failure became known, when it is not a delivery report.
  via?: string;
}
export async function recordBounce(
  tx: Tx,
  sent: { message: typeof messages.$inferSelect; ticket: typeof tickets.$inferSelect },
  bounce: Bounce,
): Promise<void> {
  await tx
    .update(messages)
    .set({
      deliveryState: "review",
      source: {
        ...sent.message.source,
        deliveryError: "bounced",
        bounce: {
          status: bounce.status,
          diagnostic: bounce.diagnostic,
          at: bounce.at,
          ...(bounce.via ? { via: bounce.via } : {}),
        },
      },
    })
    .where(eq(messages.id, sent.message.id));
  // A reply that did not arrive leaves the obligation to answer open, except for an acknowledgement,
  // which was never an answer.
  if (sent.message.source.kind !== "acknowledgement" && sent.ticket.junkAt === null)
    await tx
      .update(tickets)
      .set({
        status: "open",
        resolvedAt: null,
        pendingSince: sent.ticket.pendingSince ?? bounce.at,
        revision: sql`${tickets.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, sent.ticket.id));
}
