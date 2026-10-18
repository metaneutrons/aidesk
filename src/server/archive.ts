import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { allowedProjectIds, permits, type Action, type Principal } from "../domain/permissions";
import { db } from "./db";
import { audit, jobs, projects } from "./db/schema";
import { actionsOf } from "./grants";
import { DomainError } from "./errors";
// Archiving a project. An archived project keeps all its data and is read-only: the people and tokens that
// work in it keep only the rights that read (see `identify`), it takes no mail, nothing is sent from it, its
// jobs wait where they are, and it is left out of the lists unless a list asks for it. Restoring takes it back
// as it was. Deleting an archived project is a step of its own (see `project-delete`).
const id = z.uuid();
// What a person or a token may still do in an archived project.
export const archivedActions: readonly Action[] = [
  "project.read",
  "ticket.read",
  "ticket.read_files",
  "config.read",
  "audit.read",
];
// The jobs that belong to an archived project are not taken by the worker; they wait and run after a restore.
export const jobOfOpenProject = sql`not exists (
  select 1 from ${projects} where ${projects.id} = ${jobs.projectId} and ${projects.archivedAt} is not null
)`;
// The archived ones among these projects.
export async function archivedProjectIds(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db()
    .select({ id: projects.id })
    .from(projects)
    .where(and(inArray(projects.id, [...ids]), isNotNull(projects.archivedAt)));
  return new Set(rows.map((row) => row.id));
}
// The projects that a list covers: what the caller may see with this right, without the archived ones, unless the
// caller names projects, which then are asked for, archived or not (the caller still needs the right in each).
export async function activeProjectIds(
  principal: Principal,
  action: Action,
  requested?: readonly string[],
): Promise<string[]> {
  const allowed = allowedProjectIds(principal, action);
  if (requested) {
    if (!requested.every((project) => allowed.includes(project)))
      throw new DomainError("not_found", 404);
    return [...requested];
  }
  const archived = await archivedProjectIds(allowed);
  return allowed.filter((project) => !archived.has(project));
}
// For a write that does not go through the rights of a person: a customer's reply, an arriving mail.
export async function assertProjectOpen(projectId: string): Promise<void> {
  const [row] = await db()
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (row?.archivedAt) throw new DomainError("project_archived", 409);
}
function human(principal: Principal): void {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
}
export async function archiveProject(principal: Principal, projectId: string) {
  human(principal);
  const project = id.parse(projectId);
  if (!permits(principal, project, "project.manage")) throw new DomainError("not_found", 404);
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select({ archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, project))
      .for("update");
    if (!row) throw new DomainError("not_found", 404);
    if (row.archivedAt) return { archived: true, archivedAt: row.archivedAt };
    const now = new Date();
    await tx
      .update(projects)
      .set({ archivedAt: now, archivedBy: principal.id })
      .where(eq(projects.id, project));
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "project.archive",
      targetId: project,
      detail: {},
    });
    return { archived: true, archivedAt: now };
  });
}
// Whether a person may manage a project that can be archived: the owner, or a person whose membership holds the
// right. The rights of an archived project are reduced to reading (see `identify`), so the right to manage is read
// from the membership.
export async function managesProject(principal: Principal, projectId: string): Promise<boolean> {
  if (principal.kind !== "human" || !principal.active) return false;
  if (principal.owner) return true;
  return (await actionsOf(principal.id, projectId))?.includes("project.manage") ?? false;
}
// Restoring is for the owner and for a person who manages the project.
export async function restoreProject(principal: Principal, projectId: string) {
  human(principal);
  const project = id.parse(projectId);
  if (!(await managesProject(principal, project))) throw new DomainError("not_found", 404);
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select({ archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, project))
      .for("update");
    if (!row) throw new DomainError("not_found", 404);
    if (!row.archivedAt) return { archived: false, archivedAt: null };
    await tx
      .update(projects)
      .set({ archivedAt: null, archivedBy: null })
      .where(eq(projects.id, project));
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "project.restore",
      targetId: project,
      detail: { archivedAt: row.archivedAt.toISOString() },
    });
    return { archived: false, archivedAt: null };
  });
}
