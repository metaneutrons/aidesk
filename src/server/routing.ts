import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { permits, type Principal } from "../domain/permissions";
import {
  firstMatch,
  maxRoutingRules,
  nextMember,
  routingOrder,
  routingRuleInput,
  type RoutedMail,
  type RoutingRuleInput,
} from "../domain/routing";
import { categoriesOf, categoryIn, priorityOf } from "../domain/triage";
import { queueAgentRun } from "./agent-runs";
import type { Tx } from "./changes";
import { db } from "./db";
import {
  agents,
  audit,
  operatorGroupMembers,
  operatorGroups,
  projects,
  routingRules,
  tickets,
  user,
} from "./db/schema";
import { DomainError } from "./errors";
import { actionsOf, peopleWith } from "./grants";
import { applyTriage } from "./triage";
import { emitEvent } from "./webhooks";
// The routing rules of a project (see `domain/routing.ts`). A person with the right to manage the intake of mail
// changes them, an agent does not: a rule decides who gets the tickets of customers. Every change is an audit entry.
const id = z.uuid();
function manager(principal: Principal, projectId: string): string {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  const project = id.parse(projectId);
  if (!permits(principal, project, "intake.manage")) throw new DomainError("not_found", 404);
  return project;
}
type Row = typeof routingRules.$inferSelect;
type Target = NonNullable<Row["target"]>;
const activeAgent = (agent: typeof agents.$inferSelect | undefined, project: string) =>
  agent?.projectId === project &&
  agent.active &&
  agent.expiresAt > new Date() &&
  agent.actions.includes("ticket.read");
// The person, group or agent that a rule names, for the form and for the check when a rule is saved.
async function targetName(project: string, target: Target | null): Promise<string | null> {
  if (!target) return null;
  if (target.kind === "user") {
    const [row] = await db().select({ name: user.name }).from(user).where(eq(user.id, target.id));
    return row?.name ?? null;
  }
  if (target.kind === "group") {
    const [row] = await db()
      .select({ name: operatorGroups.name })
      .from(operatorGroups)
      .where(and(eq(operatorGroups.id, target.id), eq(operatorGroups.projectId, project)));
    return row?.name ?? null;
  }
  const [row] = await db()
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, target.id));
  return row?.name ?? null;
}
async function checkTarget(project: string, target: Target | null): Promise<void> {
  if (!target) return;
  let valid: boolean;
  if (target.kind === "user") {
    const [member] = await db()
      .select({ active: user.active })
      .from(user)
      .where(eq(user.id, target.id));
    valid =
      Boolean(member?.active) &&
      Boolean((await actionsOf(target.id, project))?.includes("ticket.read"));
  } else if (target.kind === "group") {
    valid = id.safeParse(target.id).success && (await targetName(project, target)) !== null;
  } else {
    valid =
      id.safeParse(target.id).success &&
      activeAgent((await db().select().from(agents).where(eq(agents.id, target.id)))[0], project);
  }
  if (!valid) throw new DomainError("invalid_input", 400);
}
async function checkedValues(project: string, values: RoutingRuleInput) {
  await checkTarget(project, values.target);
  let category = values.category;
  if (category !== null) {
    const [row] = await db()
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, project));
    category = categoryIn(categoriesOf(row?.settings ?? {}), category);
    if (category === null) throw new DomainError("invalid_input", 400);
  }
  return { ...values, category };
}
const view = async (row: Row) => ({
  id: row.id,
  position: row.position,
  name: row.name,
  enabled: row.enabled,
  conditions: row.conditions,
  target: row.target ? { ...row.target, name: await targetName(row.projectId, row.target) } : null,
  priority: row.priority === null ? null : priorityOf(row.priority),
  category: row.category,
  createdAt: row.createdAt.toISOString(),
});
export async function listRoutingRules(principal: Principal, projectId: string) {
  const project = manager(principal, projectId);
  const rows = await db()
    .select()
    .from(routingRules)
    .where(eq(routingRules.projectId, project))
    .orderBy(asc(routingRules.position));
  return Promise.all(rows.map(view));
}
// Whom a rule can name: the people with access to the project, its groups and its active agents.
export async function listRoutingTargets(principal: Principal, projectId: string) {
  const project = manager(principal, projectId);
  const [users, groups, held] = await Promise.all([
    peopleWith(project, "ticket.read"),
    db()
      .select({ id: operatorGroups.id, name: operatorGroups.name })
      .from(operatorGroups)
      .where(eq(operatorGroups.projectId, project))
      .orderBy(operatorGroups.name),
    db().select().from(agents).where(eq(agents.projectId, project)).orderBy(agents.name),
  ]);
  return {
    users,
    groups,
    agents: held
      .filter((agent) => activeAgent(agent, project))
      .map(({ id: agentId, name, managed }) => ({ id: agentId, name, managed })),
  };
}
export async function createRoutingRule(principal: Principal, projectId: string, input: unknown) {
  const project = manager(principal, projectId);
  const values = await checkedValues(project, routingRuleInput.parse(input));
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`routing:${project}`}))`);
    const rows = await tx
      .select({ position: routingRules.position })
      .from(routingRules)
      .where(eq(routingRules.projectId, project));
    if (rows.length >= maxRoutingRules) throw new DomainError("invalid_input", 400);
    const [made] = await tx
      .insert(routingRules)
      .values({
        projectId: project,
        position: rows.reduce((top, row) => Math.max(top, row.position), 0) + 1,
        name: values.name,
        enabled: values.enabled,
        conditions: values.conditions,
        target: values.target,
        priority: values.priority,
        category: values.category,
        createdBy: principal.id,
      })
      .returning();
    if (!made) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "routing_rule.create",
      targetId: made.id,
      detail: { name: made.name },
    });
    return view(made);
  });
}
export async function updateRoutingRule(
  principal: Principal,
  projectId: string,
  ruleId: string,
  input: unknown,
) {
  const project = manager(principal, projectId);
  const values = await checkedValues(project, routingRuleInput.parse(input));
  return db().transaction(async (tx) => {
    const [changed] = await tx
      .update(routingRules)
      .set({
        name: values.name,
        enabled: values.enabled,
        conditions: values.conditions,
        target: values.target,
        priority: values.priority,
        category: values.category,
        updatedAt: new Date(),
      })
      .where(and(eq(routingRules.id, id.parse(ruleId)), eq(routingRules.projectId, project)))
      .returning();
    if (!changed) throw new DomainError("not_found", 404);
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "routing_rule.update",
      targetId: changed.id,
      detail: { name: changed.name, enabled: changed.enabled },
    });
    return view(changed);
  });
}
export async function deleteRoutingRule(principal: Principal, projectId: string, ruleId: string) {
  const project = manager(principal, projectId);
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`routing:${project}`}))`);
    const [gone] = await tx
      .delete(routingRules)
      .where(and(eq(routingRules.id, id.parse(ruleId)), eq(routingRules.projectId, project)))
      .returning();
    if (!gone) throw new DomainError("not_found", 404);
    const rest = await tx
      .select({ id: routingRules.id })
      .from(routingRules)
      .where(eq(routingRules.projectId, project))
      .orderBy(asc(routingRules.position));
    for (const [index, row] of rest.entries())
      await tx
        .update(routingRules)
        .set({ position: index + 1 })
        .where(eq(routingRules.id, row.id));
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "routing_rule.delete",
      targetId: gone.id,
      detail: { name: gone.name },
    });
    return { removed: true };
  });
}
// The new order of all rules of the project, as the list of their ids.
export async function reorderRoutingRules(principal: Principal, projectId: string, input: unknown) {
  const project = manager(principal, projectId);
  const { ids } = routingOrder.parse(input);
  await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`routing:${project}`}))`);
    const rows = await tx
      .select({ id: routingRules.id })
      .from(routingRules)
      .where(eq(routingRules.projectId, project));
    if (rows.length !== ids.length || !rows.every((row) => ids.includes(row.id)))
      throw new DomainError("invalid_input", 400);
    for (const [index, ruleId] of ids.entries())
      await tx
        .update(routingRules)
        .set({ position: index + 1 })
        .where(eq(routingRules.id, ruleId));
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "routing_rule.reorder",
      targetId: project,
      detail: { ids },
    });
  });
  return listRoutingRules(principal, project);
}
// The rule that applies to a new ticket gives it its priority and category and its assignee. A rule that finds nobody
// to give the ticket to leaves it unassigned, which the overview and the audit show; the rest of the rule still
// applies. A failure of the routing never fails the intake of the mail: it is rolled back to a savepoint and audited.
export async function routeNewTicket(
  tx: Tx,
  ticket: { id: string; projectId: string; number: number | null },
  mail: RoutedMail,
): Promise<void> {
  const rules = await tx
    .select()
    .from(routingRules)
    .where(and(eq(routingRules.projectId, ticket.projectId), eq(routingRules.enabled, true)))
    .orderBy(asc(routingRules.position));
  const rule = firstMatch(rules, mail);
  if (!rule) return;
  try {
    await tx.transaction((inner) => applyRule(inner, ticket, rule.id));
  } catch {
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: "system",
      action: "ticket.route_failed",
      targetId: ticket.id,
      detail: { rule: { id: rule.id, name: rule.name }, reason: "error" },
    });
  }
}
async function applyRule(
  tx: Tx,
  ticket: { id: string; projectId: string; number: number | null },
  ruleId: string,
): Promise<void> {
  const [rule] = await tx
    .select()
    .from(routingRules)
    .where(eq(routingRules.id, ruleId))
    .for("update");
  if (!rule) return;
  const [project] = await tx
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, ticket.projectId));
  const category =
    rule.category === null
      ? null
      : categoryIn(categoriesOf(project?.settings ?? {}), rule.category);
  const triage = {
    ...(rule.priority === null ? {} : { priority: priorityOf(rule.priority) }),
    ...(category === null ? {} : { category }),
  };
  if (Object.keys(triage).length > 0) await applyTriage(tx, ticket.id, triage, null);
  let assignee: { userId: string | null; agentId: string | null } | null = null;
  let failure: string | null = null;
  const target = rule.target;
  if (target?.kind === "user") {
    const [member] = await tx
      .select({ active: user.active })
      .from(user)
      .where(eq(user.id, target.id));
    if (member?.active && (await actionsOf(target.id, ticket.projectId))?.includes("ticket.read"))
      assignee = { userId: target.id, agentId: null };
    else failure = "person_unavailable";
  } else if (target?.kind === "agent") {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, target.id));
    if (activeAgent(agent, ticket.projectId)) assignee = { userId: null, agentId: target.id };
    else failure = "agent_unavailable";
  } else if (target?.kind === "group") {
    const members = await tx
      .select({ id: operatorGroupMembers.userId })
      .from(operatorGroupMembers)
      .innerJoin(operatorGroups, eq(operatorGroups.id, operatorGroupMembers.groupId))
      .where(and(eq(operatorGroups.id, target.id), eq(operatorGroups.projectId, ticket.projectId)));
    const eligible = new Set((await peopleWith(ticket.projectId, "ticket.read")).map((p) => p.id));
    const chosen = nextMember(
      members.map((member) => member.id).filter((memberId) => eligible.has(memberId)),
      rule.cursor,
    );
    if (chosen === null) failure = "nobody_in_group";
    else {
      assignee = { userId: chosen, agentId: null };
      await tx
        .update(routingRules)
        .set({ cursor: rule.cursor + 1 })
        .where(eq(routingRules.id, rule.id));
    }
  }
  if (assignee) {
    await tx
      .update(tickets)
      .set({
        assigneeUserId: assignee.userId,
        assigneeAgentId: assignee.agentId,
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, ticket.id));
    await emitEvent(tx, ticket.projectId, "ticket.assigned", {
      ticketId: ticket.id,
      number: ticket.number,
      assigneeUserId: assignee.userId,
      assigneeAgentId: assignee.agentId,
      previousUserId: null,
      previousAgentId: null,
      actorId: "system",
    });
    if (assignee.agentId) await queueAgentRun(tx, ticket.id, "assignment");
  }
  await tx.insert(audit).values({
    projectId: ticket.projectId,
    actorId: "system",
    action: failure ? "ticket.route_failed" : "ticket.route",
    targetId: ticket.id,
    detail: {
      rule: { id: rule.id, name: rule.name },
      ...(failure ? { reason: failure } : {}),
      assigneeUserId: assignee?.userId ?? null,
      assigneeAgentId: assignee?.agentId ?? null,
      ...triage,
    },
  });
}
