import { cancelAgentRuns, cancelRunsOfAgent, queueAgentRun, takeOver } from "./agent-runs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { signed } from "../domain/profile";
import { actionsOf, peopleWith } from "./grants";
import { maxTags, normalizeTag, tagPattern } from "../domain/tags";
import { supersedeOlder } from "./configuration";
import { emitEvent } from "./webhooks";
import { aiWorkOf } from "./ai-work";
import type { Tx } from "./changes";
import { clampLimit, listStep } from "../domain/paging";
import { businessSettingsOf, calendarOf, clockMillis } from "../domain/business-hours";
import {
  defaultOverdueHours,
  defaultWarnHours,
  limitsOf,
  priorityLimitsOf,
} from "../domain/response-clock";
import { categoriesOf, priorities, priorityOf } from "../domain/triage";
import { overdueLimit } from "./response-clock";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z, ZodError } from "zod";
import { db } from "./db";
import {
  account,
  agents,
  attachments,
  audit,
  ingress,
  connections,
  jobs,
  memberships,
  operatorGroupMembers,
  operatorGroups,
  messages,
  projects,
  projectTags,
  session,
  tickets,
  user,
} from "./db/schema";
import { activeProjectIds } from "./archive";
import { DomainError } from "./errors";
import { markdownHtml, markdownLinks } from "./markdown";
import { getObject } from "./storage";
import {
  extractableByName,
  imageByName,
  forAgent,
  looksBinary,
  looksLikeDocument,
  readableAsText,
  type Unreadable,
} from "../domain/attachments";
import { modelState, textState, type ReadFailure, type TextState } from "./attachment-text";

import { cleanText, flagsOf, type Flag } from "../domain/untrusted";
import { htmlToMarkdown } from "./inbound";
import { simpleParser } from "mailparser";
import { renderOriginal } from "./original";
import {
  actions,
  allowedProjectIds,
  isAction,
  permits,
  type Action,
  type Principal,
} from "../domain/permissions";
const id = z.uuid();
// `archived`: the archived projects are left out ("hide"), listed with the others ("include") or the only ones ("only").
export type ArchivedFilter = "hide" | "include" | "only";
export async function listProjects(principal: Principal, archived: ArchivedFilter = "hide") {
  const allowed = allowedProjectIds(principal);
  if (allowed.length === 0) return [];
  const colours = new Map<string, Record<string, string>>();
  for (const row of await db()
    .select()
    .from(projectTags)
    .where(inArray(projectTags.projectId, allowed)))
    colours.set(row.projectId, { ...colours.get(row.projectId), [row.tag]: row.color });
  return db()
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      color: projects.color,
      defaultLanguage: projects.defaultLanguage,
      acknowledgements: sql<boolean>`coalesce((${projects.settings}->>'acknowledgements')::boolean, false)`,
      portalLinks: sql<boolean>`coalesce((${projects.settings}->>'portalLinks')::boolean, false)`,
      overdueHours: sql<number>`coalesce((${projects.settings}->>'overdueHours')::int, ${defaultOverdueHours})`,
      warnHours: sql<number>`least(coalesce((${projects.settings}->>'warnHours')::int, ${defaultWarnHours}), coalesce((${projects.settings}->>'overdueHours')::int, ${defaultOverdueHours}))`,
      archivedAt: projects.archivedAt,
      settings: projects.settings,
    })
    .from(projects)
    .where(
      and(
        inArray(projects.id, allowed),
        archived === "hide"
          ? isNull(projects.archivedAt)
          : archived === "only"
            ? isNotNull(projects.archivedAt)
            : undefined,
      ),
    )
    .orderBy(projects.name)
    .then((rows) =>
      rows.map(({ settings, ...row }) => ({
        ...row,
        tagColors: colours.get(row.id) ?? {},
        clock: businessSettingsOf(settings),
        limits: priorityLimitsOf(settings),
        categories: categoriesOf(settings),
      })),
    );
}
// Project behaviour that people with project.manage may change. Only the
// listed fields are accepted; other settings are kept as they are.
export const projectSettingsInput = z
  .object({ acknowledgements: z.boolean(), portalLinks: z.boolean() })
  .partial()
  .strict()
  .refine((values) => Object.keys(values).length > 0);
export async function setProjectSettings(principal: Principal, projectId: string, input: unknown) {
  const project = id.parse(projectId);
  if (principal.kind !== "human" || !permits(principal, project, "project.manage"))
    throw new DomainError("forbidden", 403);
  const values = projectSettingsInput.parse(input);
  return db().transaction(async (tx) => {
    const [updated] = await tx
      .update(projects)
      .set({
        settings: sql`${projects.settings} || ${JSON.stringify(values)}::jsonb`,
        configVersion: sql`${projects.configVersion} + 1`,
      })
      .where(eq(projects.id, project))
      .returning({ id: projects.id, version: projects.configVersion });
    if (!updated) throw new DomainError("not_found", 404);
    // A new version of the configuration; proposals on the old one lapse.
    await supersedeOlder(tx, project, updated.version);
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "project.settings",
      targetId: project,
      detail: values,
    });
    return values;
  });
}
// The list is loaded in steps: 250 conversations, oldest unanswered first, and
// more on request up to a fixed ceiling. The overview below does not depend on
// how much of the list was loaded.
export async function listTickets(
  principal: Principal,
  requested: string[] = [],
  limit: number = listStep,
  // Only the tickets of a priority or a category; the category is matched in any case.
  only: { priority?: string | undefined; category?: string | undefined } = {},
) {
  const filtered = await activeProjectIds(
    principal,
    "ticket.read",
    requested.length ? requested.map((value) => id.parse(value)) : undefined,
  );
  if (filtered.length === 0) return [];
  return db()
    .select()
    .from(tickets)
    .where(
      and(
        inArray(tickets.projectId, filtered),
        isNull(tickets.junkAt),
        only.priority === undefined
          ? undefined
          : eq(tickets.priority, z.enum(priorities).parse(only.priority)),
        only.category === undefined
          ? undefined
          : sql`lower(${tickets.category}) = lower(${only.category})`,
      ),
    )
    .orderBy(sql`${tickets.pendingSince} asc nulls last`, desc(tickets.updatedAt))
    .limit(clampLimit(limit));
}
// What needs attention, counted in the database over every ticket of the
// authorized projects and not over the loaded part of the list: per project the
// total, the tickets unanswered for more than a day, the open ones nobody
// handles, the due reminders and the ones waiting for the customer, plus the
// oldest unanswered tickets of each project. Junk is not counted.
const oldestPerProject = 8;
export async function getOverview(
  principal: Principal,
  requested: string[] = [],
  now: Date = new Date(),
) {
  const filtered = await activeProjectIds(
    principal,
    "ticket.read",
    requested.length ? requested.map((value) => id.parse(value)) : undefined,
  );
  if (filtered.length === 0) return { projects: [], oldest: [] };
  const instant = now.toISOString();
  const counted = (condition: ReturnType<typeof sql>) =>
    sql<number>`(count(*) filter (where ${condition}))::int`;
  const [projectRows, oldest] = await Promise.all([
    db()
      .select({
        projectId: tickets.projectId,
        total: sql<number>`count(*)::int`,
        // The limit is the project's own, 24 hours unless it set another.
        overdue: counted(
          sql`${tickets.pendingSince} <= ${instant}::timestamptz - make_interval(hours => ${overdueLimit})`,
        ),
        unassigned: counted(
          sql`${tickets.status} = 'open' and ${tickets.assigneeUserId} is null and ${tickets.assigneeAgentId} is null`,
        ),
        remindersDue: counted(sql`${tickets.remindAt} <= ${instant}::timestamptz`),
        waiting: counted(sql`${tickets.status} = 'waiting'`),
      })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(and(inArray(tickets.projectId, filtered), isNull(tickets.junkAt)))
      .groupBy(tickets.projectId),
    Promise.all(
      filtered.map((projectId) =>
        db()
          .select()
          .from(tickets)
          .where(
            and(
              eq(tickets.projectId, projectId),
              isNull(tickets.junkAt),
              isNotNull(tickets.pendingSince),
            ),
          )
          .orderBy(sql`${tickets.pendingSince} asc`)
          .limit(oldestPerProject),
      ),
    ),
  ]);
  // A project with business hours counts its overdue tickets in business time, which the database does not know.
  const clocks = await db()
    .select({ id: projects.id, settings: projects.settings })
    .from(projects)
    .where(inArray(projects.id, filtered));
  const counted_ = new Map<string, number>();
  for (const { id: projectId, settings } of clocks) {
    const calendar = calendarOf(settings);
    if (!calendar) continue;
    // Business time is never longer than calendar time, so what is not overdue by the calendar is not at all.
    const waiting = await db()
      .select({ pendingSince: tickets.pendingSince, priority: tickets.priority })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(
        and(
          eq(tickets.projectId, projectId),
          isNull(tickets.junkAt),
          sql`${tickets.pendingSince} <= ${instant}::timestamptz - make_interval(hours => ${overdueLimit})`,
        ),
      );
    counted_.set(
      projectId,
      waiting.filter(
        (ticket) =>
          ticket.pendingSince !== null &&
          clockMillis(ticket.pendingSince, now, calendar) >=
            limitsOf(settings, priorityOf(ticket.priority)).overdueHours * 3_600_000,
      ).length,
    );
  }
  return {
    projects: projectRows.map((row) => ({
      ...row,
      overdue: counted_.get(row.projectId) ?? row.overdue,
    })),
    oldest: oldest.flat(),
  };
}
// Search across the authorized projects, decided in the database: a ticket
// matches when the text is in its subject, the requester's name or address, or
// any of its messages (private notes included, as for anyone who may read the
// ticket). Junk is not searched. The authorization is part of the query, so no
// ticket of another project is ever matched or counted.
const searchLimit = 50;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);
function snippetAround(text: string, query: string): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  const from = Math.max(0, at - 60);
  const piece = text
    .slice(from, from + 160)
    .replace(/\s+/g, " ")
    .trim();
  return `${from > 0 ? "…" : ""}${piece}${text.length > from + 160 ? "…" : ""}`;
}
export async function searchTickets(principal: Principal, text: unknown, requested: string[] = []) {
  const query = z.string().trim().min(2).max(100).parse(text);
  const filtered = await activeProjectIds(
    principal,
    "ticket.read",
    requested.length ? requested.map((value) => id.parse(value)) : undefined,
  );
  if (filtered.length === 0) return [];
  const pattern = `%${escapeLike(query)}%`;
  const found = await db()
    .select({
      id: tickets.id,
      number: tickets.number,
      projectId: tickets.projectId,
      subject: tickets.subject,
      status: tickets.status,
      requesterName: tickets.requesterName,
      requesterEmail: tickets.requesterEmail,
      pendingSince: tickets.pendingSince,
      updatedAt: tickets.updatedAt,
    })
    .from(tickets)
    .where(
      and(
        inArray(tickets.projectId, filtered),
        isNull(tickets.junkAt),
        sql`(${tickets.subject} ilike ${pattern} escape '\\'
          or ${tickets.requesterName} ilike ${pattern} escape '\\'
          or ${tickets.requesterEmail} ilike ${pattern} escape '\\'
          or exists (select 1 from jsonb_array_elements_text(${tickets.tags}) as tag
            where tag ilike ${pattern} escape '\\')
          or exists (select 1 from ${messages} where ${messages.ticketId} = ${tickets.id}
            and ${messages.markdown} ilike ${pattern} escape '\\'))`,
      ),
    )
    .orderBy(desc(tickets.updatedAt))
    .limit(searchLimit);
  if (found.length === 0) return [];
  // The first message that contains the text, for the context of a hit.
  const hits = await db()
    .select({ ticketId: messages.ticketId, markdown: messages.markdown })
    .from(messages)
    .where(
      and(
        inArray(
          messages.ticketId,
          found.map((ticket) => ticket.id),
        ),
        sql`${messages.markdown} ilike ${pattern} escape '\\'`,
      ),
    )
    .orderBy(messages.createdAt);
  const first = new Map<string, string>();
  for (const hit of hits) if (!first.has(hit.ticketId)) first.set(hit.ticketId, hit.markdown);
  return found.map((ticket) => {
    const inMessage = first.get(ticket.id);
    return { ...ticket, snippet: inMessage ? snippetAround(inMessage, query) : null };
  });
}
// A reminder is a time at which the team wants to see a ticket again. It is
// private to the team, does not change the conversation (so the revision that
// protects replies stays as it is), and stays until it is changed or cleared.
// A time in the past is due at once; more than a year ahead or back is refused.
export const reminderInput = z
  .object({ remindAt: z.union([z.iso.datetime({ offset: true }), z.null()]) })
  .strict();
export async function setReminder(principal: Principal, ticketId: string, input: unknown) {
  const { remindAt } = reminderInput.parse(input);
  const { ticket } = await getTicket(principal, ticketId);
  if (!permits(principal, ticket.projectId, "ticket.note")) throw new DomainError("forbidden", 403);
  const at = remindAt === null ? null : new Date(remindAt);
  if (at !== null && Math.abs(at.getTime() - Date.now()) > 366 * 86_400_000)
    throw new DomainError("invalid_input", 400);
  if (ticket.junkAt !== null) throw new DomainError("conflict", 409);
  return db().transaction(async (tx) => {
    await tx.update(tickets).set({ remindAt: at }).where(eq(tickets.id, ticket.id));
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: at ? "ticket.remind" : "ticket.remind_clear",
      targetId: ticket.id,
      detail: { remindAt: at?.toISOString() ?? null },
    });
    return { remindAt: at };
  });
}
// Opening and resolving a ticket without writing a message. Resolving ends the
// response obligation; reopening starts none, since no customer message is
// waiting. "waiting" is not set by hand: it follows a reply. A status change
// is part of the conversation, so it raises the revision that protects replies
// and names the one the writer read.
export const statusInput = z
  .object({
    status: z.enum(["open", "resolved"]),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export async function setTicketStatus(principal: Principal, ticketId: string, input: unknown) {
  const values = statusInput.parse(input);
  const { ticket } = await getTicket(principal, ticketId);
  if (!permits(principal, ticket.projectId, "ticket.resolve"))
    throw new DomainError("forbidden", 403);
  if (ticket.junkAt !== null) throw new DomainError("conflict", 409);
  if (values.expectedRevision !== ticket.revision) throw new DomainError("conflict", 409);
  if (ticket.status === values.status)
    return { status: ticket.status, revision: ticket.revision, changed: false };
  return db().transaction(async (tx) => {
    const [changed] = await tx
      .update(tickets)
      .set({
        status: values.status,
        resolvedAt: values.status === "resolved" ? new Date() : null,
        pendingSince: values.status === "resolved" ? null : ticket.pendingSince,
        revision: sql`${tickets.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(tickets.id, ticket.id), eq(tickets.revision, values.expectedRevision)))
      .returning({ status: tickets.status, revision: tickets.revision });
    if (!changed) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "ticket.status",
      targetId: ticket.id,
      detail: { from: ticket.status, to: values.status },
    });
    await emitEvent(tx, ticket.projectId, "ticket.status_changed", {
      ticketId: ticket.id,
      number: ticket.number,
      from: ticket.status,
      to: values.status,
    });
    // A resolved ticket is not worked on any more.
    if (values.status === "resolved") await cancelAgentRuns(tx, ticket.id, "ticket_resolved");
    return { ...changed, changed: true };
  });
}
// Who handles a ticket: a person with access to the project, an agent of the
// project that may answer or note, or nobody. At most one of the two.
export const assignInput = z
  .object({ userId: z.string().min(1).nullable(), agentId: z.uuid().nullable() })
  .strict()
  .refine(({ userId, agentId }) => userId === null || agentId === null, {
    message: "Name a person or an agent, not both",
    path: ["agentId"],
  });
// Whom a ticket can be assigned to: the people with access to its project and its active agents.
export async function listAssignees(principal: Principal, ticketId: string) {
  const { ticket } = await getTicket(principal, ticketId);
  if (!permits(principal, ticket.projectId, "ticket.assign"))
    throw new DomainError("forbidden", 403);
  const people = await peopleWith(ticket.projectId, "ticket.read");
  const held = await db()
    .select()
    .from(agents)
    .where(and(eq(agents.projectId, ticket.projectId), eq(agents.active, true)))
    .orderBy(agents.name);
  return {
    users: people,
    agents: held
      .filter((agent) => agent.expiresAt > new Date() && agent.actions.includes("ticket.read"))
      .map(({ id, name, managed }) => ({ id, name, managed })),
  };
}
export async function assignTicket(principal: Principal, ticketId: string, input: unknown) {
  const values = assignInput.parse(input);
  const { ticket } = await getTicket(principal, ticketId);
  if (!permits(principal, ticket.projectId, "ticket.assign"))
    throw new DomainError("forbidden", 403);
  if (ticket.junkAt !== null) throw new DomainError("conflict", 409);
  if (values.userId !== null) {
    const [member] = await db()
      .select({ active: user.active })
      .from(user)
      .where(eq(user.id, values.userId));
    if (
      !member?.active ||
      !(await actionsOf(values.userId, ticket.projectId))?.includes("ticket.read")
    )
      throw new ZodError([
        { code: "custom", path: ["userId"], message: "A person with access to this project" },
      ]);
  }
  if (values.agentId !== null) {
    const [agent] = await db().select().from(agents).where(eq(agents.id, values.agentId));
    if (
      agent?.projectId !== ticket.projectId ||
      !agent.active ||
      agent.expiresAt <= new Date() ||
      !agent.actions.includes("ticket.read")
    )
      throw new ZodError([
        { code: "custom", path: ["agentId"], message: "An active agent of this project" },
      ]);
  }
  return db().transaction(async (tx) => {
    await tx
      .update(tickets)
      .set({
        assigneeUserId: values.userId,
        assigneeAgentId: values.agentId,
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, ticket.id));
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "ticket.assign",
      targetId: ticket.id,
      detail: {
        from: ticket.assigneeUserId ?? ticket.assigneeAgentId,
        to: values.userId ?? values.agentId,
      },
    });
    // A new assignee is a takeover of what an agent was doing, and a managed agent that
    // gets the ticket starts on it. A person who assigns a ticket also lifts a stop that a
    // takeover had put on it.
    await cancelAgentRuns(tx, ticket.id, "reassigned", {
      ...(values.agentId ? { keepAgent: values.agentId } : {}),
    });
    await tx.update(tickets).set({ agentPausedAt: null }).where(eq(tickets.id, ticket.id));
    if (values.agentId) await queueAgentRun(tx, ticket.id, "assignment");
    if ((ticket.assigneeUserId ?? ticket.assigneeAgentId) !== (values.userId ?? values.agentId))
      await emitEvent(tx, ticket.projectId, "ticket.assigned", {
        ticketId: ticket.id,
        number: ticket.number,
        assigneeUserId: values.userId,
        assigneeAgentId: values.agentId,
        previousUserId: ticket.assigneeUserId,
        previousAgentId: ticket.assigneeAgentId,
        actorId: principal.id,
      });
    return { assigneeUserId: values.userId, assigneeAgentId: values.agentId };
  });
}
// Tags are short labels that a team puts on tickets to find them again. They
// are private to the team, free text in a normalized form (lowercase, letters,
// digits, hyphen and underscore, 1 to 30 characters), at most ten per ticket,
// and replace the earlier list as a whole. Like reminders they do not change
// the conversation, so the revision that protects replies stays as it is.
export { maxTags, normalizeTag };
export const tagsInput = z
  .object({
    tags: z
      .array(z.string().max(60))
      .max(maxTags * 2)
      .transform((values) => [...new Set(values.map(normalizeTag))].sort()),
  })
  .strict()
  .refine(({ tags }) => tags.length <= maxTags && tags.every((tag) => tagPattern.test(tag)));
export async function setTicketTags(principal: Principal, ticketId: string, input: unknown) {
  const { tags } = tagsInput.parse(input);
  const { ticket } = await getTicket(principal, ticketId);
  if (!permits(principal, ticket.projectId, "ticket.note")) throw new DomainError("forbidden", 403);
  if (ticket.junkAt !== null) throw new DomainError("conflict", 409);
  return db().transaction(async (tx) => {
    await tx.update(tickets).set({ tags }).where(eq(tickets.id, ticket.id));
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "ticket.tags",
      targetId: ticket.id,
      detail: { tags },
    });
    return { tags };
  });
}
// The tags in use in the authorized projects, most used first, for filters and
// suggestions. Junk is not counted, and nothing of an unauthorized project is.
export async function listTags(principal: Principal, requested: string[] = []) {
  const filtered = await activeProjectIds(
    principal,
    "ticket.read",
    requested.length ? requested.map((value) => id.parse(value)) : undefined,
  );
  if (filtered.length === 0) return [];
  const rows = await db().execute<{ tag: string; count: number }>(sql`
    select tag, count(*)::int as count
    from ${tickets}, jsonb_array_elements_text(${tickets.tags}) as tag
    where ${inArray(tickets.projectId, filtered)} and ${tickets.junkAt} is null
    group by tag order by count desc, tag asc limit 100`);
  return rows.map((row) => ({ tag: row.tag, count: row.count }));
}
function junkCheckOf(value: unknown): "clean" | "uncertain" | "failed" | null {
  const result =
    typeof value === "object" && value !== null && "result" in value ? value.result : null;
  return result === "clean" || result === "uncertain" || result === "failed" ? result : null;
}
// Who has the ticket, by name, for the desk and for an agent that reads it.
async function assigneeOf(tx: Pick<Tx, "select">, ticket: typeof tickets.$inferSelect) {
  if (ticket.assigneeUserId) {
    const [person] = await tx
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, ticket.assigneeUserId));
    return {
      kind: "user" as const,
      id: ticket.assigneeUserId,
      name: person?.name ?? "",
      managed: false,
    };
  }
  if (ticket.assigneeAgentId) {
    const [agent] = await tx
      .select({ name: agents.name, managed: agents.managed })
      .from(agents)
      .where(eq(agents.id, ticket.assigneeAgentId));
    return {
      kind: "agent" as const,
      id: ticket.assigneeAgentId,
      name: agent?.name ?? "",
      managed: agent?.managed === true,
    };
  }
  return null;
}
export async function getTicket(principal: Principal, ticketId: string) {
  const allowed = allowedProjectIds(principal, "ticket.read");
  if (!allowed.length) throw new DomainError("not_found", 404);
  // One snapshot for ticket and messages. Read separately, a delivery that
  // commits in between returned the message as sent with the ticket still
  // open, and the desk stopped refreshing on that inconsistent state.
  const { ticket, conversation, files, assignee, work } = await db().transaction(
    async (tx) => {
      const [found] = await tx
        .select()
        .from(tickets)
        .where(and(eq(tickets.id, id.parse(ticketId)), inArray(tickets.projectId, allowed)))
        .limit(1);
      if (!found) throw new DomainError("not_found", 404);
      const rows = await tx
        .select()
        .from(messages)
        .where(eq(messages.ticketId, found.id))
        .orderBy(messages.createdAt);
      const files = rows.length
        ? await tx
            .select({
              id: attachments.id,
              messageId: attachments.messageId,
              filename: attachments.filename,
              contentType: attachments.contentType,
              size: attachments.size,
              inline: attachments.inline,
              refusal: attachments.refusal,
            })
            .from(attachments)
            .where(
              inArray(
                attachments.messageId,
                rows.map((row) => row.id),
              ),
            )
            .orderBy(attachments.messageId, attachments.position)
        : [];
      return {
        ticket: found,
        conversation: rows,
        files,
        assignee: await assigneeOf(tx, found),
        work: await aiWorkOf(tx, found),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  return {
    ticket,
    assignee,
    aiWork: work,
    messages: conversation.map(({ rawObjectKey, ...message }) => ({
      ...message,
      // The rendered mail is read through getSentSnapshot; here only its facts.
      source: Object.fromEntries(Object.entries(message.source).filter(([key]) => key !== "sent")),
      sent: sentSummary(message.source.sent),
      html: markdownHtml(message.markdown),
      // What a person checks before a draft of an agent goes out: where its links
      // really lead. Other messages need no such check.
      links: message.deliveryState === "draft" ? markdownLinks(message.markdown) : [],
      // The private original can be downloaded; the storage key stays inside.
      hasOriginal: rawObjectKey !== null,
      extractionUncertain: message.source.uncertain === true,
      // How the text of a customer's mail was found, for the desk: by the parser or by a model, why
      // the model's result was not used, the parser's text when a model's was used, and what a
      // model said about junk when it was asked.
      extraction: message.source.extraction === "ai" ? ("ai" as const) : ("parser" as const),
      extractionFailure:
        typeof message.source.extractionFailure === "string"
          ? message.source.extractionFailure
          : null,
      parserMarkdown:
        message.source.extraction === "ai" &&
        typeof message.source.parser === "object" &&
        message.source.parser !== null &&
        "markdown" in message.source.parser &&
        typeof message.source.parser.markdown === "string"
          ? message.source.parser.markdown
          : null,
      junkCheck: junkCheckOf(message.source.junkCheck),
      // Why a reply went to review; only meaningful while it is there.
      deliveryError:
        message.deliveryState === "review" && typeof message.source.deliveryError === "string"
          ? message.source.deliveryError
          : null,
      attachments: files
        .filter((file) => file.messageId === message.id)
        .map(({ messageId: _messageId, ...file }) => file),
    })),
    actions: principal.grants.find((grant) => grant.projectId === ticket.projectId)?.actions ?? [],
    sender: await senderIdentity(ticket.projectId),
    // The worker sends public replies to the requester only.
    recipients: [{ name: ticket.requesterName, address: ticket.requesterEmail }],
  };
}
const snapshot = z.object({
  at: z.string(),
  transport: z.string(),
  to: z.string(),
  from: z.string(),
  replyTo: z.string(),
  subject: z.string(),
  language: z.string(),
  templateVersion: z.number(),
  designVersion: z.number().optional(),
  portalLink: z.boolean().optional(),
  markdown: z.string(),
  html: z.string(),
  text: z.string(),
});
function sentSummary(value: unknown) {
  const parsed = snapshot.safeParse(value);
  if (!parsed.success) return null;
  const { at, transport, to, from, replyTo, subject, language, templateVersion, designVersion } =
    parsed.data;
  return {
    at,
    transport,
    to,
    from,
    replyTo,
    subject,
    language,
    templateVersion,
    designVersion,
    portalLink: parsed.data.portalLink === true,
  };
}
// The mail exactly as it was handed to the transport. Only messages that were
// sent have one; everything else, and every message the principal may not
// read, answers not_found.
export async function getSentSnapshot(principal: Principal, messageId: string) {
  const allowed = allowedProjectIds(principal, "ticket.read");
  if (!allowed.length) throw new DomainError("not_found", 404);
  const [found] = await db()
    .select({ source: messages.source, projectId: tickets.projectId })
    .from(messages)
    .innerJoin(tickets, eq(tickets.id, messages.ticketId))
    .where(
      and(
        eq(messages.id, id.parse(messageId)),
        eq(messages.internal, false),
        eq(messages.deliveryState, "sent"),
      ),
    );
  const parsed = snapshot.safeParse(found?.source.sent);
  if (!found || !allowed.includes(found.projectId) || !parsed.success)
    throw new DomainError("not_found", 404);
  return parsed.data;
}
// A stored attachment of a ticket the principal may read. Refused files,
// unknown ids and files of other projects all answer not_found.
async function attachmentOf(
  principal: Principal,
  attachmentId: string,
  action: Action = "ticket.read",
) {
  const allowed = allowedProjectIds(principal, action);
  if (!allowed.length) throw new DomainError("not_found", 404);
  const [file] = await db()
    .select({
      filename: attachments.filename,
      contentType: attachments.contentType,
      size: attachments.size,
      objectKey: attachments.objectKey,
      messageId: attachments.messageId,
      ticketId: tickets.id,
      projectId: tickets.projectId,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(tickets, eq(tickets.id, messages.ticketId))
    .where(
      and(
        eq(attachments.id, id.parse(attachmentId)),
        inArray(tickets.projectId, allowed),
        eq(attachments.projectId, tickets.projectId),
      ),
    )
    .limit(1);
  if (!file) throw new DomainError("not_found", 404);
  return file;
}
export async function getAttachment(principal: Principal, attachmentId: string) {
  const file = await attachmentOf(principal, attachmentId);
  if (!file.objectKey) throw new DomainError("not_found", 404);
  return {
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    content: await getObject(file.objectKey),
  };
}
// A file as text for an agent: only text types, at most agentReadLimit bytes, and
// the reason when it is not read. A file that was refused on receipt is not
// stored and says so.
// What a read of a file by a caller answers and records: the text cleaned of
// invisible characters, the flags of simple instruction patterns, the origin and
// the statement that a sender wrote it. Every read is audited with its outcome.
interface Origin {
  projectId: string;
  ticketId: string;
  messageId: string;
  attachmentId?: string;
}
// What a reader of documents found out, when the text comes from one.
interface Extracted {
  method: string;
  units: number;
  unit: string;
  hidden: number;
}
type Reason =
  | "not_stored"
  | Unreadable
  | "extraction_pending"
  | "extraction_failed"
  // An image or a scan, and the project has not switched on the task that reads them.
  | "image_reading_off";
type Read =
  | { text: string; truncated: boolean; extraction?: Extracted }
  | { reason: Reason; failure?: ReadFailure };
async function recordRead(principal: Principal, origin: Origin, kind: string, read: Read) {
  const ready = "text" in read ? read : null;
  const unread = "reason" in read ? read : null;
  const cleaned = ready ? cleanText(ready.text) : { text: "", removed: 0 };
  const flags = ready ? flagsOf(cleaned.text, cleaned.removed, ready.extraction?.hidden ?? 0) : [];
  await db()
    .insert(audit)
    .values({
      projectId: origin.projectId,
      actorId: principal.id,
      action: "file.read",
      targetId: origin.attachmentId ?? origin.messageId,
      detail: {
        kind,
        actorKind: principal.kind,
        ticketId: origin.ticketId,
        messageId: origin.messageId,
        readable: ready !== null,
        ...(unread ? { reason: unread.reason } : {}),
        ...(unread?.failure ? { failure: unread.failure } : {}),
        ...(ready?.extraction ? { extraction: ready.extraction } : {}),
        flags,
        removedCharacters: cleaned.removed,
      },
    });
  return { cleaned, flags };
}
interface Frame {
  untrusted: true;
  origin: Origin;
  removedCharacters: number;
  flags: Flag[];
}
async function framed(
  principal: Principal,
  origin: Origin,
  kind: "attachment" | "original",
  read: { text: string; truncated: boolean; extraction?: Extracted },
): Promise<Frame & { readable: true; text: string; truncated: boolean; extraction?: Extracted }>;
async function framed(
  principal: Principal,
  origin: Origin,
  kind: "attachment" | "original",
  read: { reason: Reason; failure?: ReadFailure },
): Promise<Frame & { readable: false; reason: Reason; failure?: ReadFailure; truncated: false }>;
async function framed(principal: Principal, origin: Origin, kind: string, read: Read) {
  const { cleaned, flags } = await recordRead(principal, origin, kind, read);
  return {
    untrusted: true as const,
    origin,
    removedCharacters: cleaned.removed,
    flags,
    ...("text" in read
      ? {
          readable: true as const,
          text: cleaned.text,
          truncated: read.truncated,
          ...(read.extraction ? { extraction: read.extraction } : {}),
        }
      : {
          readable: false as const,
          reason: read.reason,
          ...(read.failure ? { failure: read.failure } : {}),
          truncated: false as const,
        }),
  };
}
// A file as text for an agent. Text is read at once. A PDF or Office file is read
// by the worker: the first request queues that and answers that it is pending, a
// later one gives the text or the reason there is none.
export async function readAttachment(principal: Principal, attachmentId: string) {
  const file = await attachmentOf(principal, attachmentId, "ticket.read_files");
  const origin = {
    projectId: file.projectId,
    ticketId: file.ticketId,
    messageId: file.messageId,
    attachmentId,
  };
  // The name and the type were written by the sender as well.
  const described = {
    filename: cleanText(file.filename).text,
    contentType: cleanText(file.contentType).text,
    size: file.size,
  };
  const unread = async (reason: Reason, failure?: ReadFailure) => ({
    ...described,
    ...(await framed(principal, origin, "attachment", { reason, ...(failure ? { failure } : {}) })),
  });
  if (!file.objectKey) return unread("not_stored");
  const asText = readableAsText(file);
  if (asText) {
    const content = await getObject(file.objectKey);
    if (!looksBinary(content) && !looksLikeDocument(content))
      return {
        ...described,
        ...(await framed(principal, origin, "attachment", forAgent(content))),
      };
  }
  // Not plain text: a file that is named like a document, or one that is called
  // text and is not, goes to the reader of documents. An image goes to the model,
  // and so does a document that has no text of its own, a scan.
  const asImage = !asText && imageByName(file);
  if (!asText && !asImage && !extractableByName(file)) return unread("type_not_readable");
  const asked = { id: principal.id, kind: principal.kind };
  let state: TextState | { state: "off" } = asImage
    ? await modelState(file.projectId, attachmentId, asked)
    : await textState(file.projectId, attachmentId);
  if (
    !asImage &&
    state.state === "failed" &&
    (state.failure === "empty" || state.failure.startsWith("ai_"))
  )
    state = await modelState(file.projectId, attachmentId, asked);
  if (state.state === "off") return unread("image_reading_off");
  if (state.state === "pending") return unread("extraction_pending");
  if (state.state === "failed") return unread("extraction_failed", state.failure);
  const { text, ...extraction } = state;
  return {
    ...described,
    ...(await framed(principal, origin, "attachment", {
      ...forAgent(Buffer.from(text)),
      // What the file said, and whether the product cut it, are two facts.
      truncated: state.truncated || forAgent(Buffer.from(text)).truncated,
      extraction: {
        method: extraction.method,
        units: extraction.units,
        unit: extraction.unit,
        hidden: extraction.hidden,
      },
    })),
  };
}
// The stored original of a message for a person who may read its ticket. A
// message of another project, one without an original and an unknown id all
// answer not_found.
async function originalOf(principal: Principal, messageId: string, action: Action = "ticket.read") {
  const allowed = allowedProjectIds(principal, action);
  if (!allowed.length) throw new DomainError("not_found", 404);
  const [found] = await db()
    .select({
      rawObjectKey: messages.rawObjectKey,
      number: tickets.number,
      ticketId: tickets.id,
      projectId: tickets.projectId,
    })
    .from(messages)
    .innerJoin(tickets, eq(tickets.id, messages.ticketId))
    .where(and(eq(messages.id, id.parse(messageId)), inArray(tickets.projectId, allowed)))
    .limit(1);
  if (!found?.rawObjectKey) throw new DomainError("not_found", 404);
  return {
    number: found.number,
    key: found.rawObjectKey,
    ticketId: found.ticketId,
    projectId: found.projectId,
  };
}
// The received original of a message, for example to check a shortened
// extraction.
export async function getOriginal(principal: Principal, messageId: string) {
  const found = await originalOf(principal, messageId);
  return {
    filename: `ticket-${String(found.number)}-${messageId.slice(0, 8)}.eml`,
    content: await getObject(found.key),
  };
}
// The received mail as text for an agent: the source with its headers, cut at
// agentReadLimit bytes. The extracted Markdown of getTicket is the readable form;
// this is for what only the source shows, such as headers.
export async function readOriginal(principal: Principal, messageId: string) {
  const found = await originalOf(principal, messageId, "ticket.read_files");
  const content = await getObject(found.key);
  return {
    size: content.length,
    ...(await framed(
      principal,
      { projectId: found.projectId, ticketId: found.ticketId, messageId },
      "original",
      forAgent(content),
    )),
  };
}
// The original as a safe view: formatting kept, nothing executable, remote
// images blocked, images of the mail itself shown, and a plain-text fallback.
export async function getOriginalPreview(principal: Principal, messageId: string) {
  const found = await originalOf(principal, messageId);
  return renderOriginal(await getObject(found.key));
}
// Junk: tickets moved there by a person and inbound mail classified as junk
// before it became a ticket. Both stay out of the inbox until restored.
export async function listJunk(principal: Principal, requested: string[] = []) {
  const filtered = await activeProjectIds(
    principal,
    "ticket.read",
    requested.length ? requested.map((value) => id.parse(value)) : undefined,
  );
  if (filtered.length === 0) return [];
  const junkTickets = await db()
    .select({
      id: tickets.id,
      projectId: tickets.projectId,
      subject: tickets.subject,
      from: tickets.requesterEmail,
      at: tickets.junkAt,
      reason: tickets.junkReason,
    })
    .from(tickets)
    .where(and(inArray(tickets.projectId, filtered), isNotNull(tickets.junkAt)))
    .orderBy(desc(tickets.junkAt))
    .limit(250);
  const junkMail = await db()
    .select({
      id: ingress.id,
      projectId: ingress.projectId,
      parsed: ingress.parsed,
      classification: ingress.classification,
      origin: ingress.origin,
      at: ingress.receivedAt,
    })
    .from(ingress)
    .where(and(inArray(ingress.projectId, filtered), eq(ingress.state, "junk")))
    .orderBy(desc(ingress.receivedAt))
    .limit(250);
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return [
    ...junkTickets.map((entry) => ({
      kind: "ticket" as const,
      ...entry,
      canRestore: permits(principal, entry.projectId, "ticket.junk"),
      mailbox: null,
      at: (entry.at ?? new Date(0)).toISOString(),
      reason: entry.reason ?? "operator",
    })),
    ...junkMail.map((entry) => ({
      kind: "mail" as const,
      id: entry.id,
      projectId: entry.projectId,
      subject: text(entry.parsed?.subject),
      from: text(entry.parsed?.from),
      at: entry.at.toISOString(),
      reason: text(entry.classification?.reason) || "classified",
      canRestore: permits(principal, entry.projectId, "ticket.junk"),
      // Whether the original in an IMAP mailbox has followed into junk.
      mailbox:
        entry.origin?.kind === "imap"
          ? text((entry.origin.junkSync as { state?: unknown } | undefined)?.state) || "pending"
          : null,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 250);
}
async function junkMailOf(principal: Principal, ingressId: string, action: Action) {
  const allowed = allowedProjectIds(principal, action);
  if (!allowed.length) throw new DomainError("not_found", 404);
  const [entry] = await db()
    .select()
    .from(ingress)
    .where(and(eq(ingress.id, id.parse(ingressId)), inArray(ingress.projectId, allowed)))
    .limit(1);
  if (!entry) throw new DomainError("not_found", 404);
  return entry;
}
// A junk mail with a sanitized preview of its content. The original stays
// private; nothing from it is fetched or executed.
export async function getJunkMail(principal: Principal, ingressId: string) {
  const entry = await junkMailOf(principal, ingressId, "ticket.read");
  if (entry.state !== "junk") throw new DomainError("not_found", 404);
  const mail = await simpleParser(await getObject(entry.rawObjectKey));
  const body =
    typeof mail.html === "string" && mail.html.trim()
      ? htmlToMarkdown(mail.html)
      : (mail.text ?? "");
  return {
    id: entry.id,
    projectId: entry.projectId,
    subject: (mail.subject ?? "").trim() || "(no subject)",
    from: typeof entry.parsed?.from === "string" ? entry.parsed.from : "",
    receivedAt: entry.receivedAt.toISOString(),
    reason:
      typeof entry.classification?.reason === "string" ? entry.classification.reason : "classified",
    attachments: mail.attachments.length,
    html: markdownHtml(body.trim() || "(no text content)"),
  };
}
// Hands a junk mail back to inbound processing, which then threads it like
// any other mail. Restoring twice has no further effect.
export async function restoreJunkMail(principal: Principal, ingressId: string) {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
  const entry = await junkMailOf(principal, ingressId, "ticket.read");
  if (!permits(principal, entry.projectId, "ticket.junk")) throw new DomainError("forbidden", 403);
  // The original of a mail that the retention of the project has removed cannot be read again.
  if (!entry.rawObjectKey) throw new DomainError("conflict", 409);
  return db().transaction(async (tx) => {
    const [restored] = await tx
      .update(ingress)
      .set({
        state: "queued",
        classification: {
          ...entry.classification,
          restored: { by: principal.id, at: new Date().toISOString() },
        },
      })
      .where(and(eq(ingress.id, entry.id), eq(ingress.state, "junk")))
      .returning({ id: ingress.id });
    if (!restored) throw new DomainError("conflict", 409);
    await tx.insert(jobs).values({
      projectId: entry.projectId,
      type: "mail.ingest",
      dedupKey: `ingest-restore:${entry.id}`,
      payload: { ingressId: entry.id },
    });
    // The original in an IMAP mailbox goes back to the polled folder.
    if (entry.origin?.kind === "imap")
      await tx.insert(jobs).values({
        projectId: entry.projectId,
        type: "mail.junk_sync",
        dedupKey: `junk-sync:${entry.id}:restore`,
        payload: { ingressId: entry.id },
      });
    await tx.insert(audit).values({
      projectId: entry.projectId,
      actorId: principal.id,
      action: "junk.restore",
      targetId: entry.id,
    });
    return { restored: true };
  });
}
async function setTicketJunk(principal: Principal, ticketId: string, junk: boolean) {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
  const { ticket } = await getTicket(principal, ticketId);
  if (!permits(principal, ticket.projectId, "ticket.junk")) throw new DomainError("forbidden", 403);
  return db().transaction(async (tx) => {
    const [changed] = await tx
      .update(tickets)
      .set(
        junk
          ? { junkAt: new Date(), junkReason: "operator", updatedAt: new Date() }
          : { junkAt: null, junkReason: null, updatedAt: new Date() },
      )
      .where(
        and(eq(tickets.id, ticket.id), junk ? isNull(tickets.junkAt) : isNotNull(tickets.junkAt)),
      )
      .returning({ id: tickets.id });
    if (!changed) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: junk ? "ticket.junk" : "ticket.restore",
      targetId: ticket.id,
    });
    if (junk) await cancelAgentRuns(tx, ticket.id, "ticket_junk");
    return { junk };
  });
}
export async function moveTicketToJunk(principal: Principal, ticketId: string) {
  return setTicketJunk(principal, ticketId, true);
}
export async function restoreTicket(principal: Principal, ticketId: string) {
  return setTicketJunk(principal, ticketId, false);
}
// Name and address of the project's outgoing identity, without any other
// connection settings.
async function senderIdentity(projectId: string) {
  const [project] = await db()
    .select({ name: projects.name, settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, projectId));
  const connectionId = project?.settings.outboundConnectionId;
  if (!project || typeof connectionId !== "string") return null;
  const [connection] = await db()
    .select({ config: connections.config })
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.projectId, projectId)));
  const address = connection?.config.from;
  return typeof address === "string" ? { name: project.name, address } : null;
}
export const createProjectInput = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(60),
  defaultLanguage: z.enum(["en", "de"]).default("en"),
});
export async function createProject(principal: Principal, input: unknown) {
  if (!principal.active || !principal.owner || principal.kind !== "human")
    throw new DomainError("forbidden", 403);
  const values = createProjectInput.parse(input);
  return db().transaction(async (tx) => {
    const [project] = await tx.insert(projects).values(values).returning();
    if (!project) throw new DomainError("conflict", 409);
    await tx
      .insert(memberships)
      .values({ userId: principal.id, projectId: project.id, actions: [...actions] });
    await tx.insert(audit).values({
      projectId: project.id,
      actorId: principal.id,
      action: "project.create",
      targetId: project.id,
    });
    return project;
  });
}
export const replyInput = z.object({
  markdown: z.string().trim().min(1).max(100_000),
  internal: z.boolean().default(false),
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.uuid(),
  language: z.string().min(2).max(35),
  resolve: z.boolean().default(false),
});
export async function reply(principal: Principal, ticketId: string, input: unknown) {
  const values = replyInput.parse(input);
  const { ticket } = await getTicket(principal, ticketId);
  const action = values.internal ? "ticket.note" : "ticket.reply";
  if (
    !permits(principal, ticket.projectId, action) ||
    (values.resolve && !permits(principal, ticket.projectId, "ticket.resolve"))
  )
    throw new DomainError("forbidden", 403);
  if (values.resolve && values.internal) throw new DomainError("invalid_input", 400);
  // A ticket in junk gets no public reply until a person restores it.
  if (!values.internal && ticket.junkAt) throw new DomainError("conflict", 409);
  const project = await db()
    .select()
    .from(projects)
    .where(eq(projects.id, ticket.projectId))
    .then((rows) => rows[0]);
  const outgoingId = project?.settings.outboundConnectionId;
  if (!values.internal && typeof outgoingId !== "string")
    throw new DomainError("invalid_input", 400);
  if (!values.internal && values.language !== ticket.language)
    throw new DomainError("invalid_input", 400);
  const [operator] =
    principal.kind === "human"
      ? await db()
          .select({ name: user.name, displayName: user.displayName, signature: user.signature })
          .from(user)
          .where(eq(user.id, principal.id))
      : [];
  // A person's reply carries the name and the signature that they set; a note and the draft of an agent do not.
  const writtenAs = operator?.displayName ?? operator?.name ?? "Agent";
  const body =
    principal.kind === "human" && !values.internal
      ? signed(values.markdown, operator?.signature)
      : values.markdown;
  // Under the review policy an agent's reply to a customer is a draft: it is
  // stored, not queued, and a person with ticket.reply sends or discards it.
  const draft =
    !values.internal && principal.kind === "agent" && project?.settings.approvalPolicy !== "direct";
  // Under direct an agent answers only the tickets assigned to it, and says so when it
  // tries, not only when the worker would refuse to send.
  if (
    !values.internal &&
    principal.kind === "agent" &&
    !draft &&
    ticket.assigneeAgentId !== principal.id
  )
    throw new DomainError("forbidden", 403);
  return db().transaction(async (tx) => {
    const dedupKey = `reply:${principal.id}:${values.idempotencyKey}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ ticketId: ticket.id, ...values }))
      .digest("hex");
    const [existing] = await tx.select().from(jobs).where(eq(jobs.dedupKey, dedupKey)).limit(1);
    if (existing) {
      if (existing.payload.fingerprint !== fingerprint) throw new DomainError("conflict", 409);
      return {
        id: String(existing.payload.messageId),
        duplicate: true,
        draft: existing.type === "draft.recorded",
      };
    }
    if (draft) {
      // A draft leaves the conversation as it is, so the revision stays; the
      // revision that was read has to be the current one, and the draft keeps it.
      const [still] = await tx
        .select({ revision: tickets.revision })
        .from(tickets)
        .where(and(eq(tickets.id, ticket.id), eq(tickets.revision, values.expectedRevision)));
      if (!still) throw new DomainError("conflict", 409);
      const draftId = randomUUID();
      await tx.insert(messages).values({
        id: draftId,
        ticketId: ticket.id,
        authorType: principal.kind,
        authorName: writtenAs,
        internal: false,
        markdown: values.markdown,
        language: values.language,
        deliveryState: "draft",
        source: { draft: { baseRevision: still.revision, resolve: values.resolve } },
      });
      await tx.insert(jobs).values({
        projectId: ticket.projectId,
        type: "draft.recorded",
        dedupKey,
        status: "succeeded",
        payload: {
          fingerprint,
          ticketId: ticket.id,
          messageId: draftId,
          markdown: values.markdown,
          actorId: principal.id,
          actorKind: principal.kind,
          expectedRevision: still.revision,
          connectionId: outgoingId ?? null,
          resolve: values.resolve,
        },
      });
      await tx.insert(audit).values({
        projectId: ticket.projectId,
        actorId: principal.id,
        action: "ticket.draft",
        targetId: draftId,
      });
      await emitEvent(tx, ticket.projectId, "draft.created", {
        ticketId: ticket.id,
        number: ticket.number,
        messageId: draftId,
        agentId: principal.id,
      });
      return { id: draftId, duplicate: false, draft: true };
    }
    const [current] = await tx
      .update(tickets)
      .set({ revision: sql`${tickets.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(tickets.id, ticket.id), eq(tickets.revision, values.expectedRevision)))
      .returning();
    if (!current) throw new DomainError("conflict", 409);
    const messageId = randomUUID();
    await tx.insert(messages).values({
      id: messageId,
      ticketId: ticket.id,
      authorType: principal.kind,
      authorName: writtenAs,
      internal: values.internal,
      markdown: body,
      language: values.language,
      deliveryState: values.internal ? "internal" : "queued",
    });
    await tx.insert(jobs).values({
      projectId: ticket.projectId,
      type: values.internal ? "note.recorded" : "mail.send",
      dedupKey,
      status: values.internal ? "succeeded" : "queued",
      payload: {
        fingerprint,
        ticketId: ticket.id,
        messageId,
        markdown: body,
        actorId: principal.id,
        actorKind: principal.kind,
        expectedRevision: current.revision,
        connectionId: outgoingId ?? null,
        resolve: values.resolve,
      },
    });
    await tx
      .insert(audit)
      .values({ projectId: ticket.projectId, actorId: principal.id, action, targetId: messageId });
    // A person who answers a ticket that a managed agent works takes it over.
    if (principal.kind === "human" && !values.internal) await takeOver(tx, ticket.id);
    return { id: messageId, duplicate: false, draft: false };
  });
}
const draftSource = z.object({
  draft: z.object({ baseRevision: z.number().int(), resolve: z.boolean() }),
});
// The draft of an agent, with the ticket it belongs to, for a person who may
// answer in that project.
async function draftOf(principal: Principal, messageId: string) {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
  const [row] = await db()
    .select({ message: messages, ticket: tickets })
    .from(messages)
    .innerJoin(tickets, eq(tickets.id, messages.ticketId))
    .where(eq(messages.id, id.parse(messageId)));
  if (!row || !permits(principal, row.ticket.projectId, "ticket.read"))
    throw new DomainError("not_found", 404);
  if (!permits(principal, row.ticket.projectId, "ticket.reply"))
    throw new DomainError("forbidden", 403);
  if (row.message.deliveryState !== "draft") throw new DomainError("conflict", 409);
  const parsed = draftSource.safeParse(row.message.source);
  if (!parsed.success) throw new DomainError("conflict", 409);
  return { ...row, draft: parsed.data.draft };
}
// A person sends the draft of an agent. The draft was written for the ticket as
// it was; if the ticket has changed since (a customer wrote, someone answered),
// it is refused and has to be written again.
export async function sendDraft(principal: Principal, messageId: string) {
  const { message, ticket, draft } = await draftOf(principal, messageId);
  if (draft.resolve && !permits(principal, ticket.projectId, "ticket.resolve"))
    throw new DomainError("forbidden", 403);
  if (ticket.junkAt !== null || ticket.revision !== draft.baseRevision)
    throw new DomainError("conflict", 409);
  const [project] = await db().select().from(projects).where(eq(projects.id, ticket.projectId));
  const outgoingId = project?.settings.outboundConnectionId;
  if (typeof outgoingId !== "string") throw new DomainError("invalid_input", 400);
  return db().transaction(async (tx) => {
    const [current] = await tx
      .update(tickets)
      .set({ revision: sql`${tickets.revision} + 1`, updatedAt: new Date() })
      .where(and(eq(tickets.id, ticket.id), eq(tickets.revision, draft.baseRevision)))
      .returning();
    if (!current) throw new DomainError("conflict", 409);
    const [queued] = await tx
      .update(messages)
      .set({
        deliveryState: "queued",
        source: { ...message.source, draft: { ...draft, approvedBy: principal.id } },
      })
      .where(and(eq(messages.id, message.id), eq(messages.deliveryState, "draft")))
      .returning({ id: messages.id });
    if (!queued) throw new DomainError("conflict", 409);
    await tx.insert(jobs).values({
      projectId: ticket.projectId,
      type: "mail.send",
      dedupKey: `draft:${message.id}`,
      status: "queued",
      payload: {
        fingerprint: createHash("sha256").update(message.markdown).digest("hex"),
        ticketId: ticket.id,
        messageId: message.id,
        markdown: message.markdown,
        actorId: principal.id,
        actorKind: "human",
        expectedRevision: current.revision,
        connectionId: outgoingId,
        resolve: draft.resolve,
      },
    });
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "ticket.draft_send",
      targetId: message.id,
    });
    return { id: message.id, state: "queued" as const };
  });
}
export async function discardDraft(principal: Principal, messageId: string) {
  const { message, ticket } = await draftOf(principal, messageId);
  return db().transaction(async (tx) => {
    const [gone] = await tx
      .update(messages)
      .set({ deliveryState: "discarded" })
      .where(and(eq(messages.id, message.id), eq(messages.deliveryState, "draft")))
      .returning({ id: messages.id });
    if (!gone) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: ticket.projectId,
      actorId: principal.id,
      action: "ticket.draft_discard",
      targetId: message.id,
    });
    return { id: message.id, state: "discarded" as const };
  });
}
export const localeInput = z.object({ locale: z.enum(["en", "de"]).nullable() });
export async function setLocale(principal: Principal, input: unknown): Promise<void> {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
  const { locale } = localeInput.parse(input);
  await db().update(user).set({ locale }).where(eq(user.id, principal.id));
}
export async function operatorInfo(principal: Principal) {
  if (principal.kind !== "human") return { name: "Agent", locale: null, owner: false };
  const [operator] = await db()
    .select({ name: user.name, locale: user.locale, owner: user.owner })
    .from(user)
    .where(eq(user.id, principal.id));
  if (!operator) throw new DomainError("unauthenticated", 401);
  return operator;
}

// Project-scoped service tokens for MCP and REST clients. Only people issue
// them, never with more than they hold themselves and never with agent
// management, so a token cannot extend its own lifetime or reach.
export const issueInput = z.object({
  name: z.string().trim().min(1).max(100),
  actions: z
    .array(z.string())
    .min(1)
    .transform((values) => [...new Set(values)]),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});
function requireAgentManager(principal: Principal, projectId: string): void {
  if (principal.kind !== "human" || !permits(principal, projectId, "agent.manage"))
    throw new DomainError("not_found", 404);
}
export async function issueAgentToken(principal: Principal, projectId: string, input: unknown) {
  const project = id.parse(projectId);
  requireAgentManager(principal, project);
  const values = issueInput.parse(input);
  const held = principal.grants.find((grant) => grant.projectId === project)?.actions ?? [];
  const requested: Action[] = [];
  for (const action of values.actions) {
    if (
      !isAction(action) ||
      action === "agent.manage" ||
      action === "config.approve" ||
      !held.includes(action)
    )
      throw new DomainError("forbidden", 403);
    requested.push(action);
  }
  const token = `aidesk_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + values.expiresInDays * 86_400_000);
  return db().transaction(async (tx) => {
    const [agent] = await tx
      .insert(agents)
      .values({
        name: values.name,
        projectId: project,
        actions: requested,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt,
      })
      .returning({ id: agents.id });
    if (!agent) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "agent.issue",
      targetId: agent.id,
      detail: { actions: requested, expiresAt: expiresAt.toISOString() },
    });
    return { id: agent.id, token, actions: requested, expiresAt };
  });
}
export async function listAgentTokens(principal: Principal, projectId: string) {
  const project = id.parse(projectId);
  requireAgentManager(principal, project);
  return db()
    .select({
      id: agents.id,
      name: agents.name,
      actions: agents.actions,
      active: agents.active,
      managed: agents.managed,
      expiresAt: agents.expiresAt,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(eq(agents.projectId, project))
    .orderBy(desc(agents.createdAt));
}
export async function revokeAgentToken(principal: Principal, agentId: string) {
  const [agent] = await db()
    .select({ id: agents.id, projectId: agents.projectId })
    .from(agents)
    .where(eq(agents.id, id.parse(agentId)))
    .limit(1);
  if (!agent) throw new DomainError("not_found", 404);
  requireAgentManager(principal, agent.projectId);
  await db().transaction(async (tx) => {
    await tx.update(agents).set({ active: false }).where(eq(agents.id, agent.id));
    await cancelRunsOfAgent(tx, agent.id, "agent_revoked");
    await tx.insert(audit).values({
      projectId: agent.projectId,
      actorId: principal.id,
      action: "agent.revoke",
      targetId: agent.id,
    });
  });
  return { revoked: true };
}

export const managedInput = z.object({
  name: z.string().trim().min(1).max(100),
  actions: z
    .array(z.string())
    .min(1)
    .max(40)
    .transform((values) => [...new Set(values)]),
});
// An agent that the product runs itself. It has no token, so nobody can act as it from
// outside; its grants are what a model working for it may do, and they never exceed those
// of the person who creates it.
export async function createManagedAgent(principal: Principal, projectId: string, input: unknown) {
  const project = id.parse(projectId);
  requireAgentManager(principal, project);
  const values = managedInput.parse(input);
  const held = principal.grants.find((grant) => grant.projectId === project)?.actions ?? [];
  const requested: Action[] = [];
  for (const action of values.actions) {
    if (
      !isAction(action) ||
      action === "agent.manage" ||
      action === "config.approve" ||
      !held.includes(action)
    )
      throw new DomainError("forbidden", 403);
    requested.push(action);
  }
  // A managed agent has no end date; it is revoked like any other.
  const expiresAt = new Date("2100-01-01T00:00:00Z");
  return db().transaction(async (tx) => {
    const [agent] = await tx
      .insert(agents)
      .values({
        name: values.name,
        projectId: project,
        actions: requested,
        // The hash of a secret that is thrown away: no token matches it.
        tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        expiresAt,
        managed: true,
      })
      .returning({ id: agents.id });
    if (!agent) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "agent.create_managed",
      targetId: agent.id,
      detail: { actions: requested },
    });
    return { id: agent.id, name: values.name, actions: requested, managed: true };
  });
}
// Operator administration. Owners create and disable operator identities;
// project access is granted per project by people who manage that project,
// never beyond the actions they hold there. Owner status alone does not grant
// project access.
function requireHuman(principal: Principal): void {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
}
function requireOwner(principal: Principal): void {
  requireHuman(principal);
  if (!principal.owner) throw new DomainError("forbidden", 403);
}
export async function listOperators(principal: Principal) {
  requireHuman(principal);
  const managed = allowedProjectIds(principal, "project.manage");
  if (!principal.owner && managed.length === 0) throw new DomainError("forbidden", 403);
  const people = await db()
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      active: user.active,
      owner: user.owner,
    })
    .from(user)
    .orderBy(user.name);
  const ids = people.map((person) => person.id);
  const [grants, logins, memberOf] = ids.length
    ? await Promise.all([
        managed.length
          ? db()
              .select({
                userId: memberships.userId,
                projectId: memberships.projectId,
                actions: memberships.actions,
              })
              .from(memberships)
              .where(and(inArray(memberships.userId, ids), inArray(memberships.projectId, managed)))
          : Promise.resolve([]),
        db()
          .select({ userId: account.userId, providerId: account.providerId })
          .from(account)
          .where(inArray(account.userId, ids)),
        managed.length
          ? db()
              .select({
                userId: operatorGroupMembers.userId,
                groupId: operatorGroups.id,
                projectId: operatorGroups.projectId,
                name: operatorGroups.name,
                actions: operatorGroups.actions,
              })
              .from(operatorGroupMembers)
              .innerJoin(operatorGroups, eq(operatorGroups.id, operatorGroupMembers.groupId))
              .where(
                and(
                  inArray(operatorGroupMembers.userId, ids),
                  inArray(operatorGroups.projectId, managed),
                ),
              )
          : Promise.resolve([]),
      ])
    : [[], [], []];
  return people.map((person) => ({
    ...person,
    signIn: logins
      .filter((login) => login.userId === person.id)
      .map((login) => (login.providerId === "credential" ? "password" : "sso"))
      .filter((value, index, all) => all.indexOf(value) === index),
    // What the person's own membership gives, which the role of the settings changes.
    grants: grants
      .filter((grant) => grant.userId === person.id)
      .map((grant) => ({ projectId: grant.projectId, actions: grant.actions })),
    // The groups of the managed projects that the person belongs to, and what they hold there altogether.
    groups: memberOf
      .filter((entry) => entry.userId === person.id)
      .map(({ groupId, projectId, name }) => ({ id: groupId, projectId, name })),
    effective: managed.flatMap((projectId) => {
      const held = new Set<Action>([
        ...grants
          .filter((grant) => grant.userId === person.id && grant.projectId === projectId)
          .flatMap((grant) => grant.actions),
        ...memberOf
          .filter((entry) => entry.userId === person.id && entry.projectId === projectId)
          .flatMap((entry) => entry.actions),
      ]);
      return held.size > 0 ? [{ projectId, actions: [...held] }] : [];
    }),
  }));
}
export const operatorInput = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
});
export async function createOperator(principal: Principal, input: unknown) {
  requireOwner(principal);
  const values = operatorInput.parse(input);
  const email = values.email.toLowerCase();
  const [existing] = await db().select({ id: user.id }).from(user).where(eq(user.email, email));
  if (existing) throw new DomainError("conflict", 409);
  const operatorId = randomUUID();
  await db().transaction(async (tx) => {
    // SSO links an identity provider account to this operator by verified
    // email; the address is the owner's assertion, hence emailVerified.
    await tx.insert(user).values({ id: operatorId, name: values.name, email, emailVerified: true });
    await tx.insert(audit).values({
      actorId: principal.id,
      action: "operator.create",
      targetId: operatorId,
      detail: { email },
    });
  });
  return { id: operatorId, name: values.name, email };
}
export const grantInput = z.object({
  projectId: z.uuid(),
  actions: z
    .array(z.string())
    .max(actions.length)
    .transform((values) => [...new Set(values)]),
});
export async function setOperatorGrant(principal: Principal, operatorId: string, input: unknown) {
  requireHuman(principal);
  const values = grantInput.parse(input);
  if (!permits(principal, values.projectId, "project.manage"))
    throw new DomainError("not_found", 404);
  const held =
    principal.grants.find((grant) => grant.projectId === values.projectId)?.actions ?? [];
  const granted: Action[] = [];
  for (const action of values.actions) {
    if (!isAction(action) || !held.includes(action)) throw new DomainError("forbidden", 403);
    granted.push(action);
  }
  const target = id.parse(operatorId);
  const [person] = await db().select({ id: user.id }).from(user).where(eq(user.id, target));
  if (!person) throw new DomainError("not_found", 404);
  await db().transaction(async (tx) => {
    if (granted.length === 0)
      await tx
        .delete(memberships)
        .where(and(eq(memberships.userId, target), eq(memberships.projectId, values.projectId)));
    else
      await tx
        .insert(memberships)
        .values({ userId: target, projectId: values.projectId, actions: granted })
        .onConflictDoUpdate({
          target: [memberships.userId, memberships.projectId],
          set: { actions: granted },
        });
    await tx.insert(audit).values({
      projectId: values.projectId,
      actorId: principal.id,
      action: "grant.set",
      targetId: target,
      detail: { actions: granted },
    });
  });
  return { userId: target, projectId: values.projectId, actions: granted };
}
export const activeInput = z.object({ active: z.boolean() });
export async function setOperatorActive(principal: Principal, operatorId: string, input: unknown) {
  requireOwner(principal);
  const { active } = activeInput.parse(input);
  const target = id.parse(operatorId);
  if (target === principal.id) throw new DomainError("forbidden", 403);
  const [person] = await db()
    .select({ id: user.id, owner: user.owner })
    .from(user)
    .where(eq(user.id, target));
  if (!person) throw new DomainError("not_found", 404);
  // Owners are the recovery path; they are not disabled from here.
  if (person.owner) throw new DomainError("forbidden", 403);
  await db().transaction(async (tx) => {
    await tx.update(user).set({ active, updatedAt: new Date() }).where(eq(user.id, target));
    if (!active) await tx.delete(session).where(eq(session.userId, target));
    await tx.insert(audit).values({
      actorId: principal.id,
      action: active ? "operator.enable" : "operator.disable",
      targetId: target,
    });
  });
  return { id: target, active };
}
