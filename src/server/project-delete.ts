import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Principal } from "../domain/permissions";
import { db } from "./db";
import { audit, ingress, jobs, projectExports, projects, tickets } from "./db/schema";
import { DomainError } from "./errors";
import { deleteObjects, listObjects } from "./storage";
// Deleting a project cannot be undone, so it is hard to do by mistake: only the owner does it, only a project that is
// archived (read-only, nothing arriving) can be deleted, the name of the project has to be typed, and an export of the
// project that was made after it was archived has to exist and its file has to be there. The audit of the project is not
// deleted with it: its entries stay as entries of the installation, and the deletion is written there with the name,
// the digest of the export and what was removed.
export const projectDeleteInput = z
  .object({
    confirmName: z.string().min(1).max(200),
    exportId: z.uuid(),
  })
  .strict();
async function removeObjects(project: string): Promise<number> {
  let removed = 0;
  for (const prefix of [`inbound/${project}/`, `attachments/${project}/`]) {
    const keys: string[] = [];
    for await (const entry of listObjects(prefix)) keys.push(entry.key);
    const failed = keys.length ? await deleteObjects(keys) : [];
    removed += keys.length - failed.length;
  }
  return removed;
}
export async function deleteProject(principal: Principal, projectId: string, input: unknown) {
  if (principal.kind !== "human" || !principal.active || !principal.owner)
    throw new DomainError("forbidden", 403);
  const project = z.uuid().parse(projectId);
  const values = projectDeleteInput.parse(input);
  const [row] = await db().select().from(projects).where(eq(projects.id, project));
  if (!row) throw new DomainError("not_found", 404);
  // Only an archived project: archiving stops what arrives and what is written, so what is exported is what is deleted.
  if (!row.archivedAt) throw new DomainError("conflict", 409);
  if (values.confirmName !== row.name) throw new DomainError("invalid_input", 400);
  const [made] = await db()
    .select()
    .from(projectExports)
    .where(and(eq(projectExports.id, values.exportId), eq(projectExports.projectId, project)));
  if (!made || made.createdAt < row.archivedAt) throw new DomainError("export_required", 409);
  // The file of the export has to be in the storage still.
  let found = false;
  for await (const entry of listObjects(made.objectKey)) {
    if (entry.key === made.objectKey) found = true;
  }
  if (!found) throw new DomainError("export_required", 409);
  const counts = await db().transaction(async (tx) => {
    const locked = await tx
      .select({ archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, project))
      .for("update");
    if (!locked[0]?.archivedAt) throw new DomainError("conflict", 409);
    const removedTickets = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.projectId, project));
    // The audit stays: its entries become entries of the installation.
    await tx.update(audit).set({ projectId: null }).where(eq(audit.projectId, project));
    await tx.delete(jobs).where(eq(jobs.projectId, project));
    await tx.delete(ingress).where(eq(ingress.projectId, project));
    if (removedTickets.length)
      await tx.delete(tickets).where(
        inArray(
          tickets.id,
          removedTickets.map((entry) => entry.id),
        ),
      );
    await tx.delete(projects).where(eq(projects.id, project));
    const counts = { ...made.counts, tickets: removedTickets.length };
    await tx.insert(audit).values({
      actorId: principal.id,
      action: "project.delete",
      targetId: project,
      detail: { name: row.name, slug: row.slug, exportId: made.id, digest: made.digest, counts },
    });
    return counts;
  });
  // The objects go after the rows: an object that is left over is found by the sweep of the storage.
  const objects = await removeObjects(project);
  return { deleted: true, counts, objects };
}
