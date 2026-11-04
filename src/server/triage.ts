import { and, eq } from "drizzle-orm";
import { categoriesOf, categoryIn, priorityOf, triageInput, type Priority } from "../domain/triage";
import { permits, type Principal } from "../domain/permissions";
import type { Tx } from "./changes";
import { db } from "./db";
import { audit, projects, tickets } from "./db/schema";
import { DomainError } from "./errors";
import { getTicket } from "./operations";
import { emitEvent } from "./webhooks";
export interface Triage {
  priority?: Priority | undefined;
  category?: string | null | undefined;
}
// Sets the priority and the category of a ticket inside a transaction, for a person, an agent or the routing of the
// project (no actor). A category has to be on the list of the project, in any case, and is stored as the list
// writes it. Nothing is written, audited or announced when the values are those that the ticket has.
export async function applyTriage(
  tx: Tx,
  ticketId: string,
  values: Triage,
  actorId: string | null,
): Promise<{ priority: Priority; category: string | null; changed: boolean }> {
  const [row] = await tx
    .select({ ticket: tickets, settings: projects.settings })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(eq(tickets.id, ticketId))
    .for("update", { of: tickets });
  if (!row) throw new DomainError("not_found", 404);
  const { ticket } = row;
  const before = { priority: priorityOf(ticket.priority), category: ticket.category };
  let category = before.category;
  if (values.category === null) category = null;
  else if (values.category !== undefined) {
    const listed = categoryIn(categoriesOf(row.settings), values.category);
    if (listed === null) throw new DomainError("invalid_input", 400);
    category = listed;
  }
  const after = { priority: values.priority ?? before.priority, category };
  if (after.priority === before.priority && after.category === before.category)
    return { ...before, changed: false };
  await tx
    .update(tickets)
    .set({ priority: after.priority, category: after.category, updatedAt: new Date() })
    .where(and(eq(tickets.id, ticket.id)));
  await tx.insert(audit).values({
    projectId: ticket.projectId,
    actorId: actorId ?? "system",
    action: "ticket.triage",
    targetId: ticket.id,
    detail: {
      priority: { from: before.priority, to: after.priority },
      category: { from: before.category, to: after.category },
    },
  });
  await emitEvent(tx, ticket.projectId, "ticket.triaged", {
    ticketId: ticket.id,
    number: ticket.number,
    priority: after.priority,
    category: after.category,
    previousPriority: before.priority,
    previousCategory: before.category,
  });
  return { ...after, changed: true };
}
export async function setTicketTriage(principal: Principal, ticketId: string, input: unknown) {
  const values = triageInput.parse(input);
  const { ticket } = await getTicket(principal, ticketId);
  if (!permits(principal, ticket.projectId, "ticket.assign"))
    throw new DomainError("forbidden", 403);
  if (ticket.junkAt !== null) throw new DomainError("conflict", 409);
  return db().transaction((tx) => applyTriage(tx, ticket.id, values, principal.id));
}
