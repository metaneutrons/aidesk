import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { groupCreate, groupMemberInput, groupUpdate } from "../domain/groups";
import { permits, type Action, type Principal } from "../domain/permissions";
import { db } from "./db";
import { audit, operatorGroupMembers, operatorGroups, user } from "./db/schema";
import { DomainError } from "./errors";
// Groups of operators in a project, for the people who manage it. A group gives its actions to all its members in
// that project; the groups are read in `identify` and wherever else a person's rights are read (see `grants.ts`).
// The rule is the one of the grants: nobody gives, and nobody takes away, what they do not hold themselves. A group
// whose actions reach beyond what the person holds is left alone: they neither change it, nor delete it, nor
// change who belongs to it.
const id = z.uuid();
function manager(principal: Principal, projectId: string) {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  const project = id.parse(projectId);
  if (!permits(principal, project, "project.manage")) throw new DomainError("not_found", 404);
  const held =
    principal.grants.find((grant) => grant.projectId === project)?.actions ?? ([] as Action[]);
  return { project, held };
}
function mustHold(held: readonly Action[], wanted: readonly Action[]) {
  if (wanted.some((action) => !held.includes(action))) throw new DomainError("forbidden", 403);
}
async function groupIn(project: string, groupId: string) {
  const [group] = await db()
    .select()
    .from(operatorGroups)
    .where(and(eq(operatorGroups.id, id.parse(groupId)), eq(operatorGroups.projectId, project)));
  if (!group) throw new DomainError("not_found", 404);
  return group;
}
async function view(rows: (typeof operatorGroups.$inferSelect)[]) {
  const members = rows.length
    ? await db()
        .select({
          groupId: operatorGroupMembers.groupId,
          id: user.id,
          name: user.name,
          email: user.email,
          active: user.active,
        })
        .from(operatorGroupMembers)
        .innerJoin(user, eq(user.id, operatorGroupMembers.userId))
        .where(
          inArray(
            operatorGroupMembers.groupId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(asc(user.name))
    : [];
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    actions: row.actions,
    members: members
      .filter((member) => member.groupId === row.id)
      .map(({ id: memberId, name, email, active }) => ({ id: memberId, name, email, active })),
  }));
}
export async function listGroups(principal: Principal, projectId: string) {
  const { project } = manager(principal, projectId);
  return view(
    await db()
      .select()
      .from(operatorGroups)
      .where(eq(operatorGroups.projectId, project))
      .orderBy(asc(operatorGroups.name)),
  );
}
export async function createGroup(principal: Principal, projectId: string, input: unknown) {
  const { project, held } = manager(principal, projectId);
  const values = groupCreate.parse(input);
  mustHold(held, values.actions);
  const [same] = await db()
    .select({ id: operatorGroups.id })
    .from(operatorGroups)
    .where(and(eq(operatorGroups.projectId, project), eq(operatorGroups.name, values.name)));
  if (same) throw new DomainError("conflict", 409);
  const [made] = await db().transaction(async (tx) => {
    const inserted = await tx
      .insert(operatorGroups)
      .values({
        projectId: project,
        name: values.name,
        actions: values.actions,
        createdBy: principal.id,
      })
      .returning();
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "group.create",
      targetId: inserted[0]?.id,
      detail: { name: values.name, actions: values.actions },
    });
    return inserted;
  });
  if (!made) throw new DomainError("conflict", 409);
  return (await view([made]))[0];
}
export async function updateGroup(
  principal: Principal,
  projectId: string,
  groupId: string,
  input: unknown,
) {
  const { project, held } = manager(principal, projectId);
  const values = groupUpdate.parse(input);
  const group = await groupIn(project, groupId);
  mustHold(held, [...group.actions, ...(values.actions ?? [])]);
  if (values.name !== undefined && values.name !== group.name) {
    const [same] = await db()
      .select({ id: operatorGroups.id })
      .from(operatorGroups)
      .where(and(eq(operatorGroups.projectId, project), eq(operatorGroups.name, values.name)));
    if (same) throw new DomainError("conflict", 409);
  }
  const [changed] = await db().transaction(async (tx) => {
    const updated = await tx
      .update(operatorGroups)
      .set({
        ...(values.name !== undefined ? { name: values.name } : {}),
        ...(values.actions !== undefined ? { actions: values.actions } : {}),
      })
      .where(eq(operatorGroups.id, group.id))
      .returning();
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "group.update",
      targetId: group.id,
      detail: {
        ...(values.name !== undefined ? { name: values.name } : {}),
        ...(values.actions !== undefined ? { actions: values.actions, before: group.actions } : {}),
      },
    });
    return updated;
  });
  if (!changed) throw new DomainError("not_found", 404);
  return (await view([changed]))[0];
}
export async function deleteGroup(principal: Principal, projectId: string, groupId: string) {
  const { project, held } = manager(principal, projectId);
  const group = await groupIn(project, groupId);
  mustHold(held, group.actions);
  await db().transaction(async (tx) => {
    const members = await tx
      .select({ userId: operatorGroupMembers.userId })
      .from(operatorGroupMembers)
      .where(eq(operatorGroupMembers.groupId, group.id));
    await tx.delete(operatorGroups).where(eq(operatorGroups.id, group.id));
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "group.delete",
      targetId: group.id,
      detail: { name: group.name, actions: group.actions, members: members.length },
    });
  });
  return { deleted: true };
}
export async function setGroupMember(
  principal: Principal,
  projectId: string,
  groupId: string,
  input: unknown,
) {
  const { project, held } = manager(principal, projectId);
  const values = groupMemberInput.parse(input);
  const group = await groupIn(project, groupId);
  mustHold(held, group.actions);
  const [person] = await db().select({ id: user.id }).from(user).where(eq(user.id, values.userId));
  if (!person) throw new DomainError("not_found", 404);
  await db().transaction(async (tx) => {
    if (values.member)
      await tx
        .insert(operatorGroupMembers)
        .values({ groupId: group.id, userId: person.id, addedBy: principal.id })
        .onConflictDoNothing();
    else
      await tx
        .delete(operatorGroupMembers)
        .where(
          and(
            eq(operatorGroupMembers.groupId, group.id),
            eq(operatorGroupMembers.userId, person.id),
          ),
        );
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: values.member ? "group.member_add" : "group.member_remove",
      targetId: person.id,
      detail: { group: group.id, name: group.name },
    });
  });
  return (await view([group]))[0];
}
