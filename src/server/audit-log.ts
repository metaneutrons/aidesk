import { and, desc, eq, gte, inArray, isNull, like, lt, or, sql, type SQL } from "drizzle-orm";
import { auditExportLimit, auditFilter, redactDetail, type AuditFilter } from "../domain/audit";
import { permits, type Principal } from "../domain/permissions";
import { db } from "./db";
import { agents, audit, user } from "./db/schema";
import { DomainError } from "./errors";
import { z } from "zod";
// The audit of a project and of the workspace, as a list that can be filtered and as an export. Who may read
// it: a person or a token with `audit.read` in the project; the entries without a project (the owner's own
// sign-ins, recoveries, the creation of operators and the switches of the workspace) only the owner. A
// reader without the right is told that there is nothing (404), like for any other setting.
const id = z.uuid();
export type ActorKind = "user" | "agent" | "customer" | "unknown";
export interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  actorName: string | null;
  actorKind: ActorKind;
  action: string;
  targetId: string | null;
  detail: unknown;
}
export interface AuditPage {
  entries: AuditEntry[];
  next: string | null;
}
interface Scope {
  where: SQL;
  scope: string | null;
}
function readable(principal: Principal, projectId: string | null): Scope {
  if (projectId === null) {
    if (!principal.owner || principal.kind !== "human" || !principal.active)
      throw new DomainError("not_found", 404);
    return { where: isNull(audit.projectId), scope: null };
  }
  const project = id.parse(projectId);
  if (!permits(principal, project, "audit.read")) throw new DomainError("not_found", 404);
  return { where: eq(audit.projectId, project), scope: project };
}
// The cursor is the time of the last entry as the database wrote it (to the microsecond, which a Date cannot
// hold) and its id, so that entries with the same time are neither repeated nor skipped.
function encode(at: string, entry: string): string {
  return Buffer.from(`${at}|${entry}`).toString("base64url");
}
function decode(cursor: string): { at: string; id: string } {
  const [at, entry] = Buffer.from(cursor, "base64url").toString().split("|");
  if (!at || !entry || !id.safeParse(entry).success || Number.isNaN(Date.parse(at)))
    throw new DomainError("invalid_input", 400);
  return { at, id: entry };
}
function conditions(base: SQL, filter: AuditFilter): SQL[] {
  const found: SQL[] = [base];
  if (filter.actor) found.push(eq(audit.actorId, filter.actor));
  if (filter.action)
    found.push(
      filter.action.endsWith(".")
        ? like(audit.action, `${filter.action.replace(/[\\%_]/g, "\\$&")}%`)
        : eq(audit.action, filter.action),
    );
  if (filter.target) found.push(eq(audit.targetId, filter.target));
  if (filter.from) found.push(gte(audit.createdAt, new Date(filter.from)));
  if (filter.to) found.push(lt(audit.createdAt, new Date(filter.to)));
  return found;
}
const parse = (input: unknown): AuditFilter => auditFilter.parse(input);
async function actors(ids: string[]): Promise<Map<string, { name: string; kind: ActorKind }>> {
  const found = new Map<string, { name: string; kind: ActorKind }>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return found;
  for (const row of await db()
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, unique)))
    found.set(row.id, { name: row.name, kind: "user" });
  const uuids = unique.filter((value) => id.safeParse(value).success);
  if (uuids.length)
    for (const row of await db()
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, uuids)))
      found.set(row.id, { name: row.name, kind: "agent" });
  return found;
}
async function read(scope: Scope, filter: AuditFilter, limit: number): Promise<AuditPage> {
  const found = conditions(scope.where, filter);
  if (filter.before) {
    const cursor = decode(filter.before);
    const older = or(
      sql`${audit.createdAt} < ${cursor.at}::timestamptz`,
      and(sql`${audit.createdAt} = ${cursor.at}::timestamptz`, lt(audit.id, cursor.id)),
    );
    if (older) found.push(older);
  }
  const rows = await db()
    .select({
      id: audit.id,
      at: sql<string>`to_char(${audit.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      actorId: audit.actorId,
      action: audit.action,
      targetId: audit.targetId,
      detail: audit.detail,
    })
    .from(audit)
    .where(and(...found))
    .orderBy(desc(audit.createdAt), desc(audit.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const names = await actors(page.map((row) => row.actorId));
  const last = page.at(-1);
  return {
    entries: page.map((row) => {
      const known = names.get(row.actorId);
      return {
        id: row.id,
        at: new Date(row.at).toISOString(),
        actorId: row.actorId,
        actorName: known?.name ?? null,
        actorKind: known?.kind ?? (row.actorId.startsWith("portal:") ? "customer" : "unknown"),
        action: row.action,
        targetId: row.targetId,
        detail: redactDetail(row.detail),
      };
    }),
    next: rows.length > limit && last ? encode(last.at, last.id) : null,
  };
}
export const listProjectAudit = async (principal: Principal, projectId: string, input: unknown) => {
  const scope = readable(principal, id.parse(projectId));
  const filter = parse(input);
  return read(scope, filter, filter.limit);
};
export const listWorkspaceAudit = async (principal: Principal, input: unknown) => {
  const scope = readable(principal, null);
  const filter = parse(input);
  return read(scope, filter, filter.limit);
};
// A cell that a spreadsheet would read as a formula is written as text.
const cell = (value: string): string => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
async function exportRows(principal: Principal, scope: Scope, input: unknown) {
  const filter = parse(input);
  const page = await read(scope, { ...filter, before: undefined }, auditExportLimit);
  const header = "time,actor_id,actor_name,actor_kind,action,target_id,detail";
  const lines = page.entries.map((entry) =>
    [
      entry.at,
      entry.actorId,
      entry.actorName ?? "",
      entry.actorKind,
      entry.action,
      entry.targetId ?? "",
      JSON.stringify(entry.detail),
    ]
      .map(cell)
      .join(","),
  );
  // Who took the export out is part of the audit, and so is how much it held.
  await db()
    .insert(audit)
    .values({
      projectId: scope.scope,
      actorId: principal.id,
      action: "audit.export",
      targetId: scope.scope,
      detail: {
        entries: page.entries.length,
        cut: page.next !== null,
        filter: Object.fromEntries(
          Object.entries({
            actor: filter.actor,
            action: filter.action,
            target: filter.target,
            from: filter.from,
            to: filter.to,
          }).filter(([, value]) => value !== undefined),
        ),
      },
    });
  return {
    filename: `audit-${new Date().toISOString().slice(0, 10)}.csv`,
    content: Buffer.from(`${[header, ...lines].join("\r\n")}\r\n`, "utf8"),
    cut: page.next !== null,
  };
}
export const exportProjectAudit = async (principal: Principal, projectId: string, input: unknown) =>
  exportRows(principal, readable(principal, id.parse(projectId)), input);
export const exportWorkspaceAudit = async (principal: Principal, input: unknown) =>
  exportRows(principal, readable(principal, null), input);
