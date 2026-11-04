import { and, asc, eq, ne, sql } from "drizzle-orm";
import { allowedProjectIds, type Principal } from "../domain/permissions";
import {
  maxViews,
  viewCreate,
  viewLists,
  viewStart,
  viewUpdate,
  type SavedView,
} from "../domain/views";
import { priorities } from "../domain/triage";
import { z } from "zod";
import { db } from "./db";
import { savedViews } from "./db/schema";
import { DomainError } from "./errors";
// The saved views of the inbox of the signed-in operator (see `domain/views.ts`). A view is a filter: it names projects,
// and what a view shows is read through the grants that the person holds now, so a project that they may not read any
// more is left out, and a view that named projects and has none left shows nothing and is not applied.
const id = z.uuid();
type Row = typeof savedViews.$inferSelect;
function human(principal: Principal): string {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  return principal.id;
}
const present = (row: Row, readable: Set<string>): SavedView => {
  const visible = row.projects.filter((project) => readable.has(project));
  return {
    id: row.id,
    name: row.name,
    list: viewLists.find((entry) => entry === row.list) ?? "inbox",
    projects: visible,
    restricted: row.projects.length > 0 && visible.length === 0,
    tag: row.tag,
    priority: priorities.find((entry) => entry === row.priority) ?? null,
    category: row.category,
    start: row.isStart,
  };
};
export async function listViews(principal: Principal) {
  const userId = human(principal);
  const readable = new Set(allowedProjectIds(principal, "ticket.read"));
  const rows = await db()
    .select()
    .from(savedViews)
    .where(eq(savedViews.userId, userId))
    .orderBy(asc(sql`lower(${savedViews.name})`));
  return { views: rows.map((row) => present(row, readable)) };
}
// A project that a person names must be one that they may read; what they may not read is not told apart from what
// does not exist.
function named(principal: Principal, projects: string[]): void {
  const readable = new Set(allowedProjectIds(principal, "ticket.read"));
  if (projects.some((project) => !readable.has(project)))
    throw new DomainError("invalid_input", 400);
}
// A name that the person has used already: the unique index says so, however the driver wraps the error.
const code = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "code" in value ? value.code : undefined;
const duplicate = (error: unknown): boolean =>
  code(error) === "23505" ||
  (typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    code(error.cause) === "23505");
export async function createView(principal: Principal, input: unknown) {
  const userId = human(principal);
  const values = viewCreate.parse(input);
  named(principal, values.projects);
  try {
    await db().transaction(async (tx) => {
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(savedViews)
        .where(eq(savedViews.userId, userId));
      if (count >= maxViews) throw new DomainError("conflict", 409);
      await tx.insert(savedViews).values({ userId, ...values });
    });
  } catch (error) {
    if (duplicate(error)) throw new DomainError("conflict", 409);
    throw error;
  }
  return listViews(principal);
}
async function own(userId: string, viewId: string): Promise<Row> {
  const [row] = await db()
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.id, id.parse(viewId)), eq(savedViews.userId, userId)));
  if (!row) throw new DomainError("not_found", 404);
  return row;
}
export async function updateView(principal: Principal, viewId: string, input: unknown) {
  const userId = human(principal);
  const values = viewUpdate.parse(input);
  await own(userId, viewId);
  if (values.projects) named(principal, values.projects);
  try {
    await db()
      .update(savedViews)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(savedViews.id, viewId), eq(savedViews.userId, userId)));
  } catch (error) {
    if (duplicate(error)) throw new DomainError("conflict", 409);
    throw error;
  }
  return listViews(principal);
}
export async function deleteView(principal: Principal, viewId: string) {
  const userId = human(principal);
  await own(userId, viewId);
  await db()
    .delete(savedViews)
    .where(and(eq(savedViews.id, viewId), eq(savedViews.userId, userId)));
  return listViews(principal);
}
// Makes a view the one that the desk opens with, or takes that away. Only one view of a person is the start.
export async function setStartView(principal: Principal, viewId: string, input: unknown) {
  const userId = human(principal);
  const { start } = viewStart.parse(input);
  await own(userId, viewId);
  await db().transaction(async (tx) => {
    await tx
      .update(savedViews)
      .set({ isStart: false })
      .where(and(eq(savedViews.userId, userId), ne(savedViews.id, viewId)));
    await tx
      .update(savedViews)
      .set({ isStart: start })
      .where(and(eq(savedViews.id, viewId), eq(savedViews.userId, userId)));
  });
  return listViews(principal);
}
