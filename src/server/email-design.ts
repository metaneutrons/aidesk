import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { audit, emailDesigns, projects } from "./db/schema";
import { DomainError } from "./errors";
import { renderEmail } from "./email";
import { emailDesignConfig, type EmailDesignConfig } from "../domain/email-design";
import { permits, type Principal } from "../domain/permissions";
// Versioned designs of a project's outgoing mail. A version never changes; a
// new one is added and then selected. Version 0 is the built-in design a
// project has until it selects one of its own.
const id = z.uuid();
const version = z.number().int().min(1);
function manage(principal: Principal, projectId: string) {
  if (principal.kind !== "human" || !permits(principal, projectId, "project.manage"))
    throw new DomainError("forbidden", 403);
}
function readable(principal: Principal, projectId: string) {
  if (!permits(principal, projectId, "project.read")) throw new DomainError("not_found", 404);
}
export async function listEmailDesigns(principal: Principal, projectId: string) {
  const project = id.parse(projectId);
  readable(principal, project);
  const [row] = await db()
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, project));
  const active = row?.settings.emailDesignVersion;
  const rows = await db()
    .select()
    .from(emailDesigns)
    .where(eq(emailDesigns.projectId, project))
    .orderBy(desc(emailDesigns.version));
  return rows.map((design) => ({
    version: design.version,
    active: design.version === active,
    config: design.config,
    createdBy: design.createdBy,
    createdAt: design.createdAt,
  }));
}
export async function createEmailDesign(principal: Principal, projectId: string, input: unknown) {
  const project = id.parse(projectId);
  readable(principal, project);
  manage(principal, project);
  const config = emailDesignConfig.parse(input);
  return db().transaction(async (tx) => {
    // One writer per project, so versions are consecutive.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`design:${project}`}))`);
    const [latest] = await tx
      .select({ version: emailDesigns.version })
      .from(emailDesigns)
      .where(eq(emailDesigns.projectId, project))
      .orderBy(desc(emailDesigns.version))
      .limit(1);
    const next = (latest?.version ?? 0) + 1;
    await tx
      .insert(emailDesigns)
      .values({ projectId: project, version: next, config, createdBy: principal.id });
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "design.create",
      targetId: project,
      detail: { version: next },
    });
    return { version: next };
  });
}
// Selects the design for mail sent from now on. Mail that was sent keeps the
// design it was rendered with. Version 0 returns to the built-in design.
export async function selectEmailDesign(
  principal: Principal,
  projectId: string,
  selected: unknown,
) {
  const project = id.parse(projectId);
  readable(principal, project);
  manage(principal, project);
  const target = z.number().int().min(0).parse(selected);
  return db().transaction(async (tx) => {
    if (target > 0) {
      const [exists] = await tx
        .select({ id: emailDesigns.id })
        .from(emailDesigns)
        .where(and(eq(emailDesigns.projectId, project), eq(emailDesigns.version, target)));
      if (!exists) throw new DomainError("not_found", 404);
    }
    await tx
      .update(projects)
      .set({
        settings: sql`${projects.settings} || ${JSON.stringify({ emailDesignVersion: target })}::jsonb`,
      })
      .where(eq(projects.id, project));
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "design.select",
      targetId: project,
      detail: { version: target },
    });
    return { version: target };
  });
}
// The design the project's mail is rendered with now.
export async function activeEmailDesign(
  projectId: string,
  settings: Record<string, unknown>,
): Promise<{ version: number; config: EmailDesignConfig } | null> {
  const selected = version.safeParse(settings.emailDesignVersion);
  if (!selected.success) return null;
  const [row] = await db()
    .select()
    .from(emailDesigns)
    .where(and(eq(emailDesigns.projectId, projectId), eq(emailDesigns.version, selected.data)));
  const config = emailDesignConfig.safeParse(row?.config);
  return row && config.success ? { version: row.version, config: config.data } : null;
}
// The mail a design produces for a sample text, rendered like a real send.
// A saved version (the selected one by default) may be previewed by anyone who
// can read the project; a draft configuration needs the right to manage it.
export async function previewEmail(principal: Principal, projectId: string, input: unknown) {
  const project = id.parse(projectId);
  readable(principal, project);
  const values = z
    .object({
      markdown: z
        .string()
        .min(1)
        .max(20_000)
        .default(
          "Hello,\n\nthis is a preview of your design.\n\n`code` and [a link](https://example.test).",
        ),
      language: z.enum(["en", "de"]).default("en"),
      version: z.number().int().min(0).optional(),
      config: z.unknown().optional(),
    })
    .parse(input);
  const [row] = await db()
    .select({
      name: projects.name,
      color: projects.color,
      settings: projects.settings,
      defaultLanguage: projects.defaultLanguage,
    })
    .from(projects)
    .where(eq(projects.id, project));
  if (!row) throw new DomainError("not_found", 404);
  let shown: { version: number; config?: EmailDesignConfig } | null;
  if (values.config !== undefined) {
    manage(principal, project);
    shown = { version: -1, config: emailDesignConfig.parse(values.config) };
  } else if (values.version !== undefined) {
    if (values.version === 0) shown = { version: 0 };
    else {
      const [found] = await db()
        .select()
        .from(emailDesigns)
        .where(and(eq(emailDesigns.projectId, project), eq(emailDesigns.version, values.version)));
      if (!found) throw new DomainError("not_found", 404);
      shown = { version: found.version, config: emailDesignConfig.parse(found.config) };
    }
  } else shown = (await activeEmailDesign(project, row.settings)) ?? { version: 0 };
  const rendered = await renderEmail({
    project: row.name,
    markdown: values.markdown,
    language: values.language,
    color: row.color,
    fallbackLanguage: row.defaultLanguage,
    ...(shown.config ? { design: shown.config } : {}),
  });
  return { version: shown.version, ...rendered };
}
