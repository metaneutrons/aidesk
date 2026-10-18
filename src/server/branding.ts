import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { brandingInput, logoInput, logoMaxBytes, sniffImage } from "../domain/branding";
import { permits, type Principal } from "../domain/permissions";
import { db } from "./db";
import { audit, portalBranding } from "./db/schema";
import { DomainError } from "./errors";
import { resolvePortalGrant } from "./portal";
import type { PortalHost } from "./portal-domains";
import { deleteObjects, getObject, putObject } from "./storage";
// How a project brands its customer page. A person with the right to change the configuration sets it, a person
// with the right to read it sees it; an agent changes nothing here. The logo is an object of the storage named by its
// own hash (`branding/<project>/<sha256>`), and only a PNG, a JPEG or a WebP is taken, by its first bytes and not by
// what the sender says it is. The page shows only what is set: a project without a row looks as before.
const id = z.uuid();
function readable(principal: Principal, projectId: string): string {
  const project = id.parse(projectId);
  if (!permits(principal, project, "config.read")) throw new DomainError("not_found", 404);
  return project;
}
function writable(principal: Principal, projectId: string): string {
  const project = readable(principal, projectId);
  if (principal.kind !== "human" || !permits(principal, project, "config.write"))
    throw new DomainError("forbidden", 403);
  return project;
}
type Row = typeof portalBranding.$inferSelect;
const view = (row: Row | undefined) => ({
  displayName: row?.displayName ?? null,
  headerText: row?.headerText ?? null,
  accentColor: row?.accentColor ?? null,
  language:
    row?.language === "en" ? ("en" as const) : row?.language === "de" ? ("de" as const) : null,
  hasLogo: Boolean(row?.logoKey),
  updatedAt: row?.updatedAt.toISOString() ?? null,
});
const rowOf = async (project: string) =>
  (await db().select().from(portalBranding).where(eq(portalBranding.projectId, project)))[0];
export async function getBranding(principal: Principal, projectId: string) {
  return view(await rowOf(readable(principal, projectId)));
}
export async function setBranding(principal: Principal, projectId: string, input: unknown) {
  const project = writable(principal, projectId);
  const values = brandingInput.parse(input);
  const set = {
    ...(values.displayName !== undefined ? { displayName: values.displayName } : {}),
    ...(values.headerText !== undefined ? { headerText: values.headerText } : {}),
    ...(values.accentColor !== undefined ? { accentColor: values.accentColor } : {}),
    ...(values.language !== undefined ? { language: values.language } : {}),
    updatedBy: principal.id,
    updatedAt: new Date(),
  };
  await db().transaction(async (tx) => {
    await tx
      .insert(portalBranding)
      .values({ projectId: project, ...set })
      .onConflictDoUpdate({ target: portalBranding.projectId, set });
    // The entry names the fields and not their text.
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "portal_branding.update",
      targetId: project,
      detail: { fields: Object.keys(values) },
    });
  });
  return view(await rowOf(project));
}
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
export async function setLogo(principal: Principal, projectId: string, input: unknown) {
  const project = writable(principal, projectId);
  const { data } = logoInput.parse(input);
  if (!base64.test(data) || data.length % 4 !== 0) throw new DomainError("invalid_input", 400);
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > logoMaxBytes) throw new DomainError("attachment_too_large", 413);
  const type = sniffImage(bytes);
  if (!type) throw new DomainError("attachment_type_blocked", 415);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const key = `branding/${project}/${digest}`;
  await putObject(key, bytes, type);
  const before = await rowOf(project);
  await db().transaction(async (tx) => {
    const set = { logoKey: key, logoType: type, updatedBy: principal.id, updatedAt: new Date() };
    await tx
      .insert(portalBranding)
      .values({ projectId: project, ...set })
      .onConflictDoUpdate({ target: portalBranding.projectId, set });
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "portal_branding.logo_set",
      targetId: project,
      detail: { type, bytes: bytes.length, sha256: digest },
    });
  });
  if (before?.logoKey && before.logoKey !== key) await deleteObjects([before.logoKey]);
  return view(await rowOf(project));
}
export async function removeLogo(principal: Principal, projectId: string) {
  const project = writable(principal, projectId);
  const before = await rowOf(project);
  if (!before?.logoKey) return view(before);
  await db().transaction(async (tx) => {
    await tx
      .update(portalBranding)
      .set({ logoKey: null, logoType: null, updatedBy: principal.id, updatedAt: new Date() })
      .where(eq(portalBranding.projectId, project));
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "portal_branding.logo_remove",
      targetId: project,
    });
  });
  await deleteObjects([before.logoKey]);
  return view(await rowOf(project));
}
async function logoOf(row: Row | undefined) {
  if (!row?.logoKey || !row.logoType) throw new DomainError("not_found", 404);
  const content = await getObject(row.logoKey).catch(() => null);
  if (!content) throw new DomainError("not_found", 404);
  return { content, type: row.logoType };
}
// For the settings, which preview it.
export async function readLogo(principal: Principal, projectId: string) {
  return logoOf(await rowOf(readable(principal, projectId)));
}
// What the customer page shows of the branding of a project, without the right of anyone: the page is reached
// through a link, and the link decides which project it is.
export async function brandingOfPage(projectId: string) {
  return view(await rowOf(projectId));
}
// The logo for the page of a link that works on this name.
export async function readPortalLogo(token: unknown, host: PortalHost | null) {
  const grant = await resolvePortalGrant(token, host);
  if (!grant) throw new DomainError("not_found", 404);
  return logoOf(await rowOf(grant.projectId));
}
