import { and, eq, inArray } from "drizzle-orm";
import type { Action, Grant } from "../domain/permissions";
import { db } from "./db";
import { memberships, operatorGroupMembers, operatorGroups, user } from "./db/schema";
type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
// What an operator holds in a project: the actions of their own membership and those of every group of that project
// that they belong to. Every place that asks what a person may do reads it here and not from the memberships alone.
const merge = (rows: { projectId: string; actions: readonly Action[] }[]): Grant[] => {
  const byProject = new Map<string, Set<Action>>();
  for (const row of rows) {
    const set = byProject.get(row.projectId) ?? new Set<Action>();
    for (const action of row.actions) set.add(action);
    byProject.set(row.projectId, set);
  }
  return [...byProject].map(([projectId, set]) => ({ projectId, actions: [...set] }));
};
export async function grantsOf(userId: string): Promise<Grant[]> {
  const [own, viaGroups] = await Promise.all([
    db()
      .select({ projectId: memberships.projectId, actions: memberships.actions })
      .from(memberships)
      .where(eq(memberships.userId, userId)),
    db()
      .select({ projectId: operatorGroups.projectId, actions: operatorGroups.actions })
      .from(operatorGroupMembers)
      .innerJoin(operatorGroups, eq(operatorGroups.id, operatorGroupMembers.groupId))
      .where(eq(operatorGroupMembers.userId, userId)),
  ]);
  return merge([...own, ...viaGroups]);
}
// The actions of a person in one project, or null when they hold none (no membership and no group).
export async function actionsOf(userId: string, projectId: string): Promise<Action[] | null> {
  const found = (await grantsOf(userId)).find((grant) => grant.projectId === projectId);
  return found ? [...found.actions] : null;
}
// The active people who hold an action in a project, by their own membership or by a group. Inside a transaction the
// reader is that transaction.
export async function peopleWith(
  projectId: string,
  action: Action,
  reader: Pick<Tx, "select"> = db(),
) {
  const [own, viaGroups] = await Promise.all([
    reader
      .select({ id: user.id, name: user.name, actions: memberships.actions })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(and(eq(memberships.projectId, projectId), eq(user.active, true))),
    reader
      .select({ id: user.id, name: user.name, actions: operatorGroups.actions })
      .from(operatorGroupMembers)
      .innerJoin(operatorGroups, eq(operatorGroups.id, operatorGroupMembers.groupId))
      .innerJoin(user, eq(user.id, operatorGroupMembers.userId))
      .where(and(eq(operatorGroups.projectId, projectId), eq(user.active, true))),
  ]);
  const found = new Map<string, { id: string; name: string; held: Set<Action> }>();
  for (const row of [...own, ...viaGroups]) {
    const entry = found.get(row.id) ?? { id: row.id, name: row.name, held: new Set<Action>() };
    for (const held of row.actions) entry.held.add(held);
    found.set(row.id, entry);
  }
  return [...found.values()]
    .filter((entry) => entry.held.has(action))
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export const groupIdsOf = (userId: string, projectIds: string[]) =>
  projectIds.length === 0
    ? Promise.resolve([] as { groupId: string; projectId: string }[])
    : db()
        .select({ groupId: operatorGroupMembers.groupId, projectId: operatorGroups.projectId })
        .from(operatorGroupMembers)
        .innerJoin(operatorGroups, eq(operatorGroups.id, operatorGroupMembers.groupId))
        .where(
          and(
            eq(operatorGroupMembers.userId, userId),
            inArray(operatorGroups.projectId, projectIds),
          ),
        );
