import { createHash, randomBytes, randomUUID } from "node:crypto";
import { maxTags, normalizeTag, tagPattern } from "../domain/tags";
import { supersedeOlder } from "./configuration";
import { emitEvent } from "./webhooks";
import { clampLimit, listStep } from "../domain/paging";
import { defaultOverdueHours } from "../domain/response-clock";
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
  messages,
  projects,
  session,
  tickets,
  user,
} from "./db/schema";
import { DomainError } from "./errors";
import { markdownHtml } from "./markdown";
import { getObject } from "./storage";
import { forAgent, looksBinary, readableAsText, type Unreadable } from "../domain/attachments";
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
export async function listProjects(principal: Principal) {
  const allowed = allowedProjectIds(principal);
  if (allowed.length === 0) return [];
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
    })
    .from(projects)
    .where(inArray(projects.id, allowed))
    .orderBy(projects.name);
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
) {
  const allowed = allowedProjectIds(principal, "ticket.read");
  const filtered = requested.length ? requested.map((value) => id.parse(value)) : allowed;
  if (filtered.some((value) => !allowed.includes(value))) throw new DomainError("not_found", 404);
  if (filtered.length === 0) return [];
  return db()
    .select()
    .from(tickets)
    .where(and(inArray(tickets.projectId, filtered), isNull(tickets.junkAt)))
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
  const allowed = allowedProjectIds(principal, "ticket.read");
  const filtered = requested.length ? requested.map((value) => id.parse(value)) : allowed;
  if (filtered.some((value) => !allowed.includes(value))) throw new DomainError("not_found", 404);
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
          sql`${tickets.pendingSince} <= ${instant}::timestamptz - make_interval(hours => coalesce((${projects.settings}->>'overdueHours')::int, ${defaultOverdueHours}))`,
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
  return { projects: projectRows, oldest: oldest.flat() };
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
  const allowed = allowedProjectIds(principal, "ticket.read");
  const filtered = requested.length ? requested.map((value) => id.parse(value)) : allowed;
  if (filtered.some((value) => !allowed.includes(value))) throw new DomainError("not_found", 404);
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
export async function assignTicket(principal: Principal, ticketId: string, input: unknown) {
  const values = assignInput.parse(input);
  const { ticket } = await getTicket(principal, ticketId);
  if (!permits(principal, ticket.projectId, "ticket.assign"))
    throw new DomainError("forbidden", 403);
  if (ticket.junkAt !== null) throw new DomainError("conflict", 409);
  if (values.userId !== null) {
    const [member] = await db()
      .select({ active: user.active, actions: memberships.actions })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(
        and(eq(memberships.userId, values.userId), eq(memberships.projectId, ticket.projectId)),
      );
    if (!member?.active || !member.actions.includes("ticket.read"))
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
  const allowed = allowedProjectIds(principal, "ticket.read");
  const filtered = requested.length ? requested.map((value) => id.parse(value)) : allowed;
  if (filtered.some((value) => !allowed.includes(value))) throw new DomainError("not_found", 404);
  if (filtered.length === 0) return [];
  const rows = await db().execute<{ tag: string; count: number }>(sql`
    select tag, count(*)::int as count
    from ${tickets}, jsonb_array_elements_text(${tickets.tags}) as tag
    where ${inArray(tickets.projectId, filtered)} and ${tickets.junkAt} is null
    group by tag order by count desc, tag asc limit 100`);
  return rows.map((row) => ({ tag: row.tag, count: row.count }));
}
export async function getTicket(principal: Principal, ticketId: string) {
  const allowed = allowedProjectIds(principal, "ticket.read");
  if (!allowed.length) throw new DomainError("not_found", 404);
  // One snapshot for ticket and messages. Read separately, a delivery that
  // commits in between returned the message as sent with the ticket still
  // open, and the desk stopped refreshing on that inconsistent state.
  const { ticket, conversation, files } = await db().transaction(
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
      return { ticket: found, conversation: rows, files };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  return {
    ticket,
    messages: conversation.map(({ rawObjectKey, ...message }) => ({
      ...message,
      // The rendered mail is read through getSentSnapshot; here only its facts.
      source: Object.fromEntries(Object.entries(message.source).filter(([key]) => key !== "sent")),
      sent: sentSummary(message.source.sent),
      html: markdownHtml(message.markdown),
      // The private original can be downloaded; the storage key stays inside.
      hasOriginal: rawObjectKey !== null,
      extractionUncertain: message.source.uncertain === true,
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
export async function readAttachment(principal: Principal, attachmentId: string) {
  const file = await attachmentOf(principal, attachmentId, "ticket.read_files");
  const described = { filename: file.filename, contentType: file.contentType, size: file.size };
  const unread = (reason: "not_stored" | Unreadable) => ({
    ...described,
    readable: false,
    reason,
    truncated: false,
  });
  if (!file.objectKey) return unread("not_stored");
  if (!readableAsText(file)) return unread("type_not_readable");
  const content = await getObject(file.objectKey);
  if (looksBinary(content)) return unread("binary_content");
  return { ...described, readable: true, ...forAgent(content) };
}
// The stored original of a message for a person who may read its ticket. A
// message of another project, one without an original and an unknown id all
// answer not_found.
async function originalOf(principal: Principal, messageId: string, action: Action = "ticket.read") {
  const allowed = allowedProjectIds(principal, action);
  if (!allowed.length) throw new DomainError("not_found", 404);
  const [found] = await db()
    .select({ rawObjectKey: messages.rawObjectKey, number: tickets.number })
    .from(messages)
    .innerJoin(tickets, eq(tickets.id, messages.ticketId))
    .where(and(eq(messages.id, id.parse(messageId)), inArray(tickets.projectId, allowed)))
    .limit(1);
  if (!found?.rawObjectKey) throw new DomainError("not_found", 404);
  return { number: found.number, key: found.rawObjectKey };
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
  return { size: content.length, ...forAgent(content) };
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
  const allowed = allowedProjectIds(principal, "ticket.read");
  const filtered = requested.length ? requested.map((value) => id.parse(value)) : allowed;
  if (filtered.some((value) => !allowed.includes(value))) throw new DomainError("not_found", 404);
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
      ? await db().select({ name: user.name }).from(user).where(eq(user.id, principal.id))
      : [];
  // Under the review policy an agent's reply to a customer is a draft: it is
  // stored, not queued, and a person with ticket.reply sends or discards it.
  const draft =
    !values.internal && principal.kind === "agent" && project?.settings.approvalPolicy !== "direct";
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
        authorName: operator?.name ?? "Agent",
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
      authorName: operator?.name ?? "Agent",
      internal: values.internal,
      markdown: values.markdown,
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
        markdown: values.markdown,
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
    await tx.insert(audit).values({
      projectId: agent.projectId,
      actorId: principal.id,
      action: "agent.revoke",
      targetId: agent.id,
    });
  });
  return { revoked: true };
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
  const [grants, logins] = ids.length
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
      ])
    : [[], []];
  return people.map((person) => ({
    ...person,
    signIn: logins
      .filter((login) => login.userId === person.id)
      .map((login) => (login.providerId === "credential" ? "password" : "sso"))
      .filter((value, index, all) => all.indexOf(value) === index),
    grants: grants
      .filter((grant) => grant.userId === person.id)
      .map((grant) => ({ projectId: grant.projectId, actions: grant.actions })),
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
