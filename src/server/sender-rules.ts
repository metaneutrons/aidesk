import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { junkSensitivityOf, type JunkSensitivity } from "../domain/junk";
import { permits, type Principal } from "../domain/permissions";
import { maxSenderRules, senderRuleInput, type SenderRuleRow } from "../domain/sender-rules";
import { db } from "./db";
import { audit, projects, senderRules } from "./db/schema";
import { DomainError } from "./errors";
// The lists of senders of a project. A person with the right to manage the intake of mail changes them; an agent
// does not, because a list decides which mail reaches the inbox. Every change is an audit entry with the rule.
const id = z.uuid();
function manager(principal: Principal, projectId: string): string {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  const project = id.parse(projectId);
  if (!permits(principal, project, "intake.manage")) throw new DomainError("not_found", 404);
  return project;
}
const view = (row: typeof senderRules.$inferSelect) => ({
  id: row.id,
  kind: row.kind === "allow" ? ("allow" as const) : ("block" as const),
  type: row.type === "address" ? ("address" as const) : ("domain" as const),
  value: row.value,
  note: row.note,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});
export async function listSenderRules(principal: Principal, projectId: string) {
  const project = manager(principal, projectId);
  const rows = await db()
    .select()
    .from(senderRules)
    .where(eq(senderRules.projectId, project))
    .orderBy(asc(senderRules.kind), asc(senderRules.value));
  return rows.map(view);
}
export async function addSenderRule(principal: Principal, projectId: string, input: unknown) {
  const project = manager(principal, projectId);
  const values = senderRuleInput.parse(input);
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sender-rules:${project}`}))`);
    const [count] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(senderRules)
      .where(eq(senderRules.projectId, project));
    if ((count?.count ?? 0) >= maxSenderRules) throw new DomainError("invalid_input", 400);
    const [same] = await tx
      .select({ id: senderRules.id })
      .from(senderRules)
      .where(and(eq(senderRules.projectId, project), eq(senderRules.value, values.value.value)));
    if (same) throw new DomainError("conflict", 409);
    const [made] = await tx
      .insert(senderRules)
      .values({
        projectId: project,
        kind: values.kind,
        type: values.value.type,
        value: values.value.value,
        note: values.note ?? null,
        createdBy: principal.id,
      })
      .returning();
    if (!made) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "sender_rule.add",
      targetId: made.id,
      detail: { kind: made.kind, type: made.type, value: made.value },
    });
    return view(made);
  });
}
export async function removeSenderRule(principal: Principal, projectId: string, ruleId: string) {
  const project = manager(principal, projectId);
  return db().transaction(async (tx) => {
    const [gone] = await tx
      .delete(senderRules)
      .where(and(eq(senderRules.id, id.parse(ruleId)), eq(senderRules.projectId, project)))
      .returning();
    if (!gone) throw new DomainError("not_found", 404);
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "sender_rule.remove",
      targetId: gone.id,
      detail: { kind: gone.kind, type: gone.type, value: gone.value },
    });
    return { removed: true };
  });
}
// What the intake needs to judge a mail of this project: how much the rules trust the headers, and the lists.
export async function senderPolicyOf(projectId: string): Promise<{
  sensitivity: JunkSensitivity;
  rules: SenderRuleRow[];
}> {
  const [project] = await db()
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, projectId));
  const rows = await db()
    .select({ kind: senderRules.kind, type: senderRules.type, value: senderRules.value })
    .from(senderRules)
    .where(eq(senderRules.projectId, projectId));
  return {
    sensitivity: junkSensitivityOf(project?.settings.junkSensitivity),
    rules: rows.map((row) => ({
      kind: row.kind === "allow" ? ("allow" as const) : ("block" as const),
      type: row.type === "address" ? ("address" as const) : ("domain" as const),
      value: row.value,
    })),
  };
}
