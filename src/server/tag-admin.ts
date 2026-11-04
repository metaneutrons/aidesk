import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { permits, type Principal } from "../domain/permissions";
import { tagColorInput, tagMerge, tagRemoval, tagRename } from "../domain/tags";
import { db } from "./db";
import { audit, projectTags, tickets } from "./db/schema";
import { DomainError } from "./errors";
// The administration of the tags of a project: a person with `project.manage` lists them with their colour and the
// number of tickets, renames one, merges several into one, colours one and removes one. Renaming and merging change
// the tickets of the project, junk included, in one transaction; a merge never gives a ticket more tags than it
// had, because a ticket that has several of the tags keeps one. Removing names the number of tickets that was shown: another number means that
// tickets changed meanwhile and nothing is removed. Every change is an audit entry with the numbers. A change of
// tags leaves the revision of a ticket as it is, like any change of tags.
const id = z.uuid();
function manager(principal: Principal, projectId: string): string {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  const project = id.parse(projectId);
  if (!permits(principal, project, "project.manage")) throw new DomainError("not_found", 404);
  return project;
}
const list = (values: readonly string[]) =>
  sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
export async function listTagAdmin(principal: Principal, projectId: string) {
  const project = manager(principal, projectId);
  const rows = await db().execute<{ tag: string; tickets: number; color: string | null }>(sql`
    select coalesce(used.tag, colours.tag) as tag, coalesce(used.tickets, 0)::int as tickets, colours.color
    from (
      select tag, count(*)::int as tickets
      from ${tickets}, jsonb_array_elements_text(${tickets.tags}) as tag
      where ${tickets.projectId} = ${project}
      group by tag
    ) used
    full join (
      select tag, color from ${projectTags} where project_id = ${project}
    ) colours on colours.tag = used.tag
    order by tickets desc, tag asc`);
  return rows.map((row) => ({ tag: row.tag, tickets: row.tickets, color: row.color }));
}
// Replaces the tags in `from` by `into` in every ticket of the project that has one of them.
async function replace(
  tx: Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0],
  project: string,
  from: readonly string[],
  into: string,
): Promise<number> {
  const mapped = sql`(
    select coalesce(jsonb_agg(value order by value), '[]'::jsonb) from (
      select distinct case when element = any(${list(from)}) then ${into} else element end as value
      from jsonb_array_elements_text(${tickets.tags}) as element
    ) as mapped
  )`;
  const changed = await tx.execute(sql`
    update ${tickets} set tags = ${mapped}
    where ${tickets.projectId} = ${project} and ${tickets.tags} ?| ${list(from)}`);
  return changed.count;
}
// A colour follows a tag that is renamed or merged: the colour of `into` wins, otherwise the first colour of `from`.
async function moveColours(
  tx: Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0],
  project: string,
  from: readonly string[],
  into: string,
) {
  const rows = await tx
    .select()
    .from(projectTags)
    .where(
      and(
        eq(projectTags.projectId, project),
        sql`${projectTags.tag} = any(${list([...from, into])})`,
      ),
    );
  const target = rows.find((row) => row.tag === into);
  const donor = rows.find((row) => row.tag !== into);
  await tx
    .delete(projectTags)
    .where(and(eq(projectTags.projectId, project), sql`${projectTags.tag} = any(${list(from)})`));
  if (!target && donor)
    await tx.insert(projectTags).values({ projectId: project, tag: into, color: donor.color });
}
export async function renameTag(principal: Principal, projectId: string, input: unknown) {
  const project = manager(principal, projectId);
  const { from, to } = tagRename.parse(input);
  if (from === to) throw new DomainError("invalid_input", 400);
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tags:${project}`}))`);
    const [taken] = await tx.execute<{ count: number }>(sql`
      select count(*)::int as count from ${tickets}
      where ${tickets.projectId} = ${project} and ${tickets.tags} ? ${to}`);
    if ((taken?.count ?? 0) > 0) throw new DomainError("conflict", 409);
    const count = await replace(tx, project, [from], to);
    if (count === 0) throw new DomainError("not_found", 404);
    await moveColours(tx, project, [from], to);
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "tag.rename",
      targetId: project,
      detail: { from, to, tickets: count },
    });
    return { tickets: count };
  });
}
export async function mergeTags(principal: Principal, projectId: string, input: unknown) {
  const project = manager(principal, projectId);
  const { from, into } = tagMerge.parse(input);
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tags:${project}`}))`);
    const count = await replace(tx, project, from, into);
    await moveColours(tx, project, from, into);
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "tag.merge",
      targetId: project,
      detail: { from, into, tickets: count },
    });
    return { tickets: count };
  });
}
export async function setTagColor(principal: Principal, projectId: string, input: unknown) {
  const project = manager(principal, projectId);
  const { tag, color } = tagColorInput.parse(input);
  return db().transaction(async (tx) => {
    if (color === null)
      await tx
        .delete(projectTags)
        .where(and(eq(projectTags.projectId, project), eq(projectTags.tag, tag)));
    else
      await tx
        .insert(projectTags)
        .values({ projectId: project, tag, color: color.toLowerCase() })
        .onConflictDoUpdate({
          target: [projectTags.projectId, projectTags.tag],
          set: { color: color.toLowerCase(), updatedAt: new Date() },
        });
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "tag.color",
      targetId: project,
      detail: { tag, color: color === null ? null : color.toLowerCase() },
    });
    return { tickets: 0 };
  });
}
export async function removeTag(principal: Principal, projectId: string, input: unknown) {
  const project = manager(principal, projectId);
  const { tag, expectedTickets } = tagRemoval.parse(input);
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tags:${project}`}))`);
    const [current] = await tx.execute<{ count: number }>(sql`
      select count(*)::int as count from ${tickets}
      where ${tickets.projectId} = ${project} and ${tickets.tags} ? ${tag}`);
    if ((current?.count ?? 0) !== expectedTickets) throw new DomainError("stale_version", 409);
    await tx.execute(sql`
      update ${tickets} set tags = tags - ${tag}::text
      where ${tickets.projectId} = ${project} and ${tickets.tags} ? ${tag}`);
    await tx
      .delete(projectTags)
      .where(and(eq(projectTags.projectId, project), eq(projectTags.tag, tag)));
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "tag.remove",
      targetId: project,
      detail: { tag, tickets: expectedTickets },
    });
    return { tickets: expectedTickets };
  });
}
