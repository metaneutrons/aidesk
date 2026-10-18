import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { permits, type Principal } from "../domain/permissions";
import { challengeName, challengeValue, hostOf, portalDomainInput } from "../domain/portal-domains";
import { db } from "./db";
import { audit, portalDomains } from "./db/schema";
import { env } from "./env";
import { DomainError } from "./errors";
// The names under which a project's customer page is reached next to the shared address (see the schema for
// how a name is claimed and proved). Only a person who manages the project sets them; they are the
// configuration of an installation, kept in its database.
const id = z.uuid();
const dnsWaitMs = 5_000;
const cacheMs = 30_000;
function manager(principal: Principal, projectId: string): string {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
  const project = id.parse(projectId);
  if (!permits(principal, project, "project.manage")) throw new DomainError("not_found", 404);
  return project;
}
export type VerifyResult = "verified" | "record_missing" | "dns_error";
type Row = typeof portalDomains.$inferSelect;
const view = (row: Row) => ({
  id: row.id,
  host: row.host,
  verified: row.verifiedAt !== null,
  verifiedAt: row.verifiedAt,
  challenge: { name: challengeName(row.host), value: challengeValue(row.token) },
  createdAt: row.createdAt,
});
// What the lookup of a name answers, kept for a short time: every request of a name that is not the
// address of the application asks it. A change made by this process drops it at once; another
// process learns of it within the time of the cache.
const known = new Map<string, { project: string | null; at: number }>();
export const forgetPortalHosts = (): void => {
  known.clear();
};
export async function portalHostProject(host: string | null): Promise<string | null> {
  const name = hostOf(host);
  if (!name) return null;
  const cached = known.get(name);
  if (cached && Date.now() - cached.at < cacheMs) return cached.project;
  const [row] = await db()
    .select({ projectId: portalDomains.projectId })
    .from(portalDomains)
    .where(and(eq(portalDomains.host, name), isNotNull(portalDomains.verifiedAt)));
  known.set(name, { project: row?.projectId ?? null, at: Date.now() });
  return row?.projectId ?? null;
}
// The host of the application itself, which is never a portal name.
export const applicationHost = (): string => new URL(env().APP_URL).host.toLowerCase();
export const isApplicationHost = (host: string, appUrl: string = env().APP_URL): boolean =>
  new URL(appUrl).host.toLowerCase() === host.toLowerCase();
// Whether a request may come from this origin: the application's own, or a name that serves a customer page.
export async function portalOriginAllowed(origin: string | null): Promise<boolean> {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin === new URL(env().APP_URL).origin) return true;
  return parsed.protocol === "https:" && (await portalHostProject(parsed.host)) !== null;
}
// The address that a link to the customer page of a project starts with: its oldest verified name, or the
// address of the application when it has none.
export async function portalBase(projectId: string): Promise<string> {
  const [row] = await db()
    .select({ host: portalDomains.host })
    .from(portalDomains)
    .where(and(eq(portalDomains.projectId, projectId), isNotNull(portalDomains.verifiedAt)))
    .orderBy(asc(portalDomains.verifiedAt), asc(portalDomains.id))
    .limit(1);
  return row ? `https://${row.host}` : new URL(env().APP_URL).origin;
}
export async function listPortalDomains(principal: Principal, projectId: string) {
  const project = manager(principal, projectId);
  const rows = await db()
    .select()
    .from(portalDomains)
    .where(eq(portalDomains.projectId, project))
    .orderBy(asc(portalDomains.createdAt), asc(portalDomains.id));
  return rows.map(view);
}
export async function addPortalDomain(principal: Principal, projectId: string, input: unknown) {
  const project = manager(principal, projectId);
  const { host } = portalDomainInput.parse(input);
  if (isApplicationHost(host)) throw new DomainError("conflict", 409);
  const [taken] = await db()
    .select({ projectId: portalDomains.projectId })
    .from(portalDomains)
    .where(and(eq(portalDomains.host, host), isNotNull(portalDomains.verifiedAt)));
  if (taken && taken.projectId !== project) throw new DomainError("conflict", 409);
  return db().transaction(async (tx) => {
    const [made] = await tx
      .insert(portalDomains)
      .values({
        projectId: project,
        host,
        token: randomBytes(16).toString("hex"),
        createdBy: principal.id,
      })
      .onConflictDoNothing()
      .returning();
    // Claiming a name again returns the claim that exists, with the token that it has.
    const [row] = made
      ? [made]
      : await tx
          .select()
          .from(portalDomains)
          .where(and(eq(portalDomains.projectId, project), eq(portalDomains.host, host)));
    if (!row) throw new DomainError("conflict", 409);
    if (made)
      await tx.insert(audit).values({
        projectId: project,
        actorId: principal.id,
        action: "portal_domain.add",
        targetId: row.id,
        detail: { host },
      });
    return view(row);
  });
}
async function lookup(host: string, value: string): Promise<VerifyResult> {
  try {
    const answer = await Promise.race([
      resolveTxt(challengeName(host)),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("timeout"));
        }, dnsWaitMs).unref();
      }),
    ]);
    const found = answer.some((chunks) => chunks.join("") === value);
    return found ? "verified" : "record_missing";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === "ENOTFOUND" || code === "ENODATA" ? "record_missing" : "dns_error";
  }
}
export async function verifyPortalDomain(
  principal: Principal,
  projectId: string,
  domainId: string,
) {
  const project = manager(principal, projectId);
  const [row] = await db()
    .select()
    .from(portalDomains)
    .where(and(eq(portalDomains.id, id.parse(domainId)), eq(portalDomains.projectId, project)));
  if (!row) throw new DomainError("not_found", 404);
  if (row.verifiedAt) return { ...view(row), result: "verified" as VerifyResult };
  const result = await lookup(row.host, challengeValue(row.token));
  if (result !== "verified") return { ...view(row), result };
  try {
    const done = await db().transaction(async (tx) => {
      const [updated] = await tx
        .update(portalDomains)
        .set({ verifiedAt: new Date() })
        .where(and(eq(portalDomains.id, row.id), eq(portalDomains.projectId, project)))
        .returning();
      if (!updated) throw new DomainError("not_found", 404);
      await tx.insert(audit).values({
        projectId: project,
        actorId: principal.id,
        action: "portal_domain.verify",
        targetId: row.id,
        detail: { host: row.host },
      });
      return updated;
    });
    forgetPortalHosts();
    return { ...view(done), result: "verified" as VerifyResult };
  } catch (error) {
    // Another project proved the same name first.
    if (
      (error as { code?: unknown }).code === "23505" ||
      (error as { cause?: { code?: unknown } }).cause?.code === "23505"
    )
      throw new DomainError("conflict", 409);
    throw error;
  }
}
export async function removePortalDomain(
  principal: Principal,
  projectId: string,
  domainId: string,
) {
  const project = manager(principal, projectId);
  const removed = await db().transaction(async (tx) => {
    const [row] = await tx
      .delete(portalDomains)
      .where(and(eq(portalDomains.id, id.parse(domainId)), eq(portalDomains.projectId, project)))
      .returning();
    if (!row) throw new DomainError("not_found", 404);
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "portal_domain.remove",
      targetId: row.id,
      detail: { host: row.host, wasVerified: row.verifiedAt !== null },
    });
    return row;
  });
  forgetPortalHosts();
  return { removed: true, host: removed.host };
}
