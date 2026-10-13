import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { audit, emailDesigns, jobs, projects, user } from "./db/schema";
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
export const selectInput = z.object({ version: z.number().int().min(0) });
export async function selectEmailDesign(
  principal: Principal,
  projectId: string,
  selected: unknown,
) {
  const project = id.parse(projectId);
  readable(principal, project);
  manage(principal, project);
  const target = selectInput.shape.version.parse(selected);
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
// The design of a saved version, the built-in one for version 0, or the one
// the project has selected when no version is asked for.
export async function designForVersion(
  projectId: string,
  settings: Record<string, unknown>,
  requested?: number,
): Promise<{ version: number; config?: EmailDesignConfig }> {
  if (requested === undefined)
    return (await activeEmailDesign(projectId, settings)) ?? { version: 0 };
  if (requested === 0) return { version: 0 };
  const [found] = await db()
    .select()
    .from(emailDesigns)
    .where(and(eq(emailDesigns.projectId, projectId), eq(emailDesigns.version, requested)));
  if (!found) throw new DomainError("not_found", 404);
  return { version: found.version, config: emailDesignConfig.parse(found.config) };
}
// The mail a design produces for a sample text, rendered like a real send.
// A saved version (the selected one by default) may be previewed by anyone who
// can read the project; a draft configuration needs the right to manage it.
export const previewInput = z.object({
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
});
export async function previewEmail(principal: Principal, projectId: string, input: unknown) {
  const project = id.parse(projectId);
  readable(principal, project);
  const values = previewInput.parse(input);
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
  let shown: { version: number; config?: EmailDesignConfig };
  if (values.config !== undefined) {
    manage(principal, project);
    shown = { version: -1, config: emailDesignConfig.parse(values.config) };
  } else shown = await designForVersion(project, row.settings, values.version);
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

// The sample text of a test mail: a heading, formatting, a list, code and a
// link, so the design can be judged in a real mail program.
export function sampleMarkdown(language: string): string {
  return language === "de"
    ? "Hallo,\n\ndies ist eine Testnachricht zur Prüfung des Designs. Sie erzeugt kein Ticket.\n\n- **Fett** und *kursiv*\n- ein [Link](https://example.test)\n- `Code` im Text\n\n```\nnpm run build\n```\n\n> Ein Zitat, wie es in einer Antwort vorkommt."
    : "Hello,\n\nthis is a test message to check the design. It creates no ticket.\n\n- **Bold** and *italic*\n- a [link](https://example.test)\n- `code` in a sentence\n\n```\nnpm run build\n```\n\n> A quotation as it appears in a reply.";
}
// A test mail of a design to the address of the person who asks, sent through
// the project's outgoing connection by the worker. The recipient cannot be
// chosen, so this is no way to send mail to anyone else. It creates no ticket
// and no message. At most ten per person and hour.
const testLimit = 10;
export const testMailInput = z
  .object({
    version: z.number().int().min(0).optional(),
    language: z.enum(["en", "de"]).default("en"),
  })
  .strict();
export async function sendTestMail(principal: Principal, projectId: string, input: unknown) {
  const project = id.parse(projectId);
  readable(principal, project);
  manage(principal, project);
  const values = testMailInput.parse(input ?? {});
  const [row] = await db()
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, project));
  const connectionId = row?.settings.outboundConnectionId;
  if (!row || typeof connectionId !== "string" || row.settings.pauseOutgoing === true)
    throw new DomainError("conflict", 409);
  await designForVersion(project, row.settings, values.version);
  const [operator] = await db().select().from(user).where(eq(user.id, principal.id));
  if (!operator?.active) throw new DomainError("forbidden", 403);
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`design-test:${principal.id}`}))`);
    const [recent] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "mail.test"),
          sql`${jobs.payload}->>'userId' = ${principal.id}`,
          sql`${jobs.createdAt} > now() - interval '1 hour'`,
        ),
      );
    if ((recent?.count ?? 0) >= testLimit) throw new DomainError("rate_limited", 429);
    const [job] = await tx
      .insert(jobs)
      .values({
        projectId: project,
        type: "mail.test",
        dedupKey: `design-test:${randomUUID()}`,
        payload: {
          userId: principal.id,
          to: operator.email,
          connectionId,
          language: values.language,
          ...(values.version === undefined ? {} : { version: values.version }),
        },
      })
      .returning({ id: jobs.id });
    if (!job) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "design.test_send",
      targetId: project,
      detail: { version: values.version ?? null },
    });
    return { id: job.id };
  });
}
// How a test mail went: queued, running, succeeded, or review with the code of
// the failure. Only the person who asked can see it.
export async function getTestMail(principal: Principal, jobId: string) {
  const [job] = await db()
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id.parse(jobId)), eq(jobs.type, "mail.test")));
  if (!job) throw new DomainError("not_found", 404);
  if (job.payload.userId !== principal.id || !permits(principal, job.projectId, "project.manage"))
    throw new DomainError("not_found", 404);
  return { id: job.id, status: job.status, code: job.lastErrorCode };
}
