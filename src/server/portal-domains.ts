import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { and, asc, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import { permits, type Principal } from "../domain/permissions";
import { challengeName, challengeValue, hostOf, portalDomainInput } from "../domain/portal-domains";
import { db } from "./db";
import { audit, portalDomains } from "./db/schema";
import { env } from "./env";
import { DomainError } from "./errors";
// The names under which the customer page is reached next to the shared address (see the schema for how a name
// is claimed and proved). A name belongs to a project, which a person who manages it sets, or to the whole
// installation, which only its owner sets: the name of the installation serves every project that has no name
// of its own. They are the configuration of an installation, kept in its database.
const id = z.uuid();
const dnsWaitMs = 5_000;
const cacheMs = 30_000;
// The one who may set the names of a scope: a person who manages the project, or the owner for the installation.
// `null` is the installation.
function setter(principal: Principal, projectId: string | null): string | null {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  if (projectId === null) {
    if (!principal.owner) throw new DomainError("forbidden", 403);
    return null;
  }
  const project = id.parse(projectId);
  if (!permits(principal, project, "project.manage")) throw new DomainError("not_found", 404);
  return project;
}
const inScope = (scope: string | null): SQL =>
  scope === null ? isNull(portalDomains.projectId) : eq(portalDomains.projectId, scope);
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
// What a name that serves the customer page belongs to: one project, or the installation.
export type PortalHost = { kind: "project"; projectId: string } | { kind: "installation" };
// What the lookup of a name answers, kept for a short time: every request of a name that is not the address of
// the application asks it. A change made by this process drops it at once; another process learns of it within
// the time of the cache.
const known = new Map<string, { host: PortalHost | null; at: number }>();
export const forgetPortalHosts = (): void => {
  known.clear();
};
export async function portalHost(host: string | null): Promise<PortalHost | null> {
  const name = hostOf(host);
  if (!name) return null;
  const cached = known.get(name);
  if (cached && Date.now() - cached.at < cacheMs) return cached.host;
  const [row] = await db()
    .select({ projectId: portalDomains.projectId })
    .from(portalDomains)
    .where(and(eq(portalDomains.host, name), isNotNull(portalDomains.verifiedAt)));
  const found: PortalHost | null = row
    ? row.projectId === null
      ? { kind: "installation" }
      : { kind: "project", projectId: row.projectId }
    : null;
  known.set(name, { host: found, at: Date.now() });
  return found;
}
// Whether a project has a verified name of its own (the name of the installation does not count).
export async function hasOwnPortalName(projectId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: portalDomains.id })
    .from(portalDomains)
    .where(and(eq(portalDomains.projectId, projectId), isNotNull(portalDomains.verifiedAt)))
    .limit(1);
  return row !== undefined;
}
// Whether a link of this project may open on this name: on the name of a project, only the links of that
// project; on the name of the installation, the links of the projects that have no name of their own; on the
// address of the application (no name), every link.
export async function hostServesProject(
  host: PortalHost | null,
  projectId: string,
): Promise<boolean> {
  if (host === null) return true;
  if (host.kind === "project") return host.projectId === projectId;
  return !(await hasOwnPortalName(projectId));
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
  return parsed.protocol === "https:" && (await portalHost(parsed.host)) !== null;
}
// The address that a link to the customer page of a project starts with: its oldest verified name; else the
// oldest verified name of the installation; else the address of the application.
export async function portalBase(projectId: string): Promise<string> {
  const oldest = async (scope: string | null) => {
    const [row] = await db()
      .select({ host: portalDomains.host })
      .from(portalDomains)
      .where(and(inScope(scope), isNotNull(portalDomains.verifiedAt)))
      .orderBy(asc(portalDomains.verifiedAt), asc(portalDomains.id))
      .limit(1);
    return row?.host;
  };
  const host = (await oldest(projectId)) ?? (await oldest(null));
  return host ? `https://${host}` : new URL(env().APP_URL).origin;
}
async function list(scope: string | null) {
  const rows = await db()
    .select()
    .from(portalDomains)
    .where(inScope(scope))
    .orderBy(asc(portalDomains.createdAt), asc(portalDomains.id));
  return rows.map(view);
}
async function add(principal: Principal, scope: string | null, input: unknown) {
  const { host } = portalDomainInput.parse(input);
  if (isApplicationHost(host)) throw new DomainError("conflict", 409);
  // A name that is proved is taken, by whoever proved it, unless it is this scope's own.
  const [taken] = await db()
    .select({ projectId: portalDomains.projectId })
    .from(portalDomains)
    .where(and(eq(portalDomains.host, host), isNotNull(portalDomains.verifiedAt)));
  if (taken && (taken.projectId ?? null) !== scope) throw new DomainError("conflict", 409);
  return db().transaction(async (tx) => {
    const [made] = await tx
      .insert(portalDomains)
      .values({
        projectId: scope,
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
          .where(and(inScope(scope), eq(portalDomains.host, host)));
    if (!row) throw new DomainError("conflict", 409);
    if (made)
      await tx.insert(audit).values({
        projectId: scope,
        actorId: principal.id,
        action: "portal_domain.add",
        targetId: row.id,
        detail: { host, scope: scope === null ? "installation" : "project" },
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
async function verify(principal: Principal, scope: string | null, domainId: string) {
  const [row] = await db()
    .select()
    .from(portalDomains)
    .where(and(eq(portalDomains.id, id.parse(domainId)), inScope(scope)));
  if (!row) throw new DomainError("not_found", 404);
  if (row.verifiedAt) return { ...view(row), result: "verified" as VerifyResult };
  const result = await lookup(row.host, challengeValue(row.token));
  if (result !== "verified") return { ...view(row), result };
  try {
    const done = await db().transaction(async (tx) => {
      const [updated] = await tx
        .update(portalDomains)
        .set({ verifiedAt: new Date() })
        .where(and(eq(portalDomains.id, row.id), inScope(scope)))
        .returning();
      if (!updated) throw new DomainError("not_found", 404);
      await tx.insert(audit).values({
        projectId: scope,
        actorId: principal.id,
        action: "portal_domain.verify",
        targetId: row.id,
        detail: { host: row.host, scope: scope === null ? "installation" : "project" },
      });
      return updated;
    });
    forgetPortalHosts();
    return { ...view(done), result: "verified" as VerifyResult };
  } catch (error) {
    // Someone else proved the same name first.
    const code =
      (error as { code?: unknown }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;
    if (code === "23505") throw new DomainError("conflict", 409);
    throw error;
  }
}
async function remove(principal: Principal, scope: string | null, domainId: string) {
  const removed = await db().transaction(async (tx) => {
    const [row] = await tx
      .delete(portalDomains)
      .where(and(eq(portalDomains.id, id.parse(domainId)), inScope(scope)))
      .returning();
    if (!row) throw new DomainError("not_found", 404);
    await tx.insert(audit).values({
      projectId: scope,
      actorId: principal.id,
      action: "portal_domain.remove",
      targetId: row.id,
      detail: {
        host: row.host,
        scope: scope === null ? "installation" : "project",
        wasVerified: row.verifiedAt !== null,
      },
    });
    return row;
  });
  forgetPortalHosts();
  return { removed: true, host: removed.host };
}
export const listPortalDomains = async (principal: Principal, projectId: string) =>
  list(setter(principal, projectId));
export const addPortalDomain = async (principal: Principal, projectId: string, input: unknown) =>
  add(principal, setter(principal, projectId), input);
export const verifyPortalDomain = async (
  principal: Principal,
  projectId: string,
  domainId: string,
) => verify(principal, setter(principal, projectId), domainId);
export const removePortalDomain = async (
  principal: Principal,
  projectId: string,
  domainId: string,
) => remove(principal, setter(principal, projectId), domainId);
export const listInstallationPortalDomains = async (principal: Principal) =>
  list(setter(principal, null));
export const addInstallationPortalDomain = async (principal: Principal, input: unknown) =>
  add(principal, setter(principal, null), input);
export const verifyInstallationPortalDomain = async (principal: Principal, domainId: string) =>
  verify(principal, setter(principal, null), domainId);
export const removeInstallationPortalDomain = async (principal: Principal, domainId: string) =>
  remove(principal, setter(principal, null), domainId);
