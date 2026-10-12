import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
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
import { htmlToMarkdown } from "./inbound";
import { simpleParser } from "mailparser";
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
    })
    .from(projects)
    .where(inArray(projects.id, allowed))
    .orderBy(projects.name);
}
// Project behaviour that people with project.manage may change. Only the
// listed fields are accepted; other settings are kept as they are.
const projectSettingsInput = z.object({ acknowledgements: z.boolean() }).strict();
export async function setProjectSettings(principal: Principal, projectId: string, input: unknown) {
  const project = id.parse(projectId);
  if (principal.kind !== "human" || !permits(principal, project, "project.manage"))
    throw new DomainError("forbidden", 403);
  const values = projectSettingsInput.parse(input);
  return db().transaction(async (tx) => {
    const [updated] = await tx
      .update(projects)
      .set({ settings: sql`${projects.settings} || ${JSON.stringify(values)}::jsonb` })
      .where(eq(projects.id, project))
      .returning({ id: projects.id });
    if (!updated) throw new DomainError("not_found", 404);
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
export async function listTickets(principal: Principal, requested: string[] = []) {
  const allowed = allowedProjectIds(principal, "ticket.read");
  const filtered = requested.length ? requested.map((value) => id.parse(value)) : allowed;
  if (filtered.some((value) => !allowed.includes(value))) throw new DomainError("not_found", 404);
  if (filtered.length === 0) return [];
  return db()
    .select()
    .from(tickets)
    .where(and(inArray(tickets.projectId, filtered), isNull(tickets.junkAt)))
    .orderBy(sql`${tickets.pendingSince} asc nulls last`, desc(tickets.updatedAt))
    .limit(250);
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
    messages: conversation.map((message) => ({
      ...message,
      html: markdownHtml(message.markdown),
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
// A stored attachment of a ticket the principal may read. Refused files,
// unknown ids and files of other projects all answer not_found.
export async function getAttachment(principal: Principal, attachmentId: string) {
  const allowed = allowedProjectIds(principal, "ticket.read");
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
  if (!file?.objectKey) throw new DomainError("not_found", 404);
  return {
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    content: await getObject(file.objectKey),
  };
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
export async function createProject(principal: Principal, input: unknown) {
  if (!principal.active || !principal.owner || principal.kind !== "human")
    throw new DomainError("forbidden", 403);
  const values = z
    .object({
      name: z.string().trim().min(1).max(100),
      slug: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(60),
      defaultLanguage: z.enum(["en", "de"]).default("en"),
    })
    .parse(input);
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
const replyInput = z.object({
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
  return db().transaction(async (tx) => {
    const dedupKey = `reply:${principal.id}:${values.idempotencyKey}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ ticketId: ticket.id, ...values }))
      .digest("hex");
    const [existing] = await tx.select().from(jobs).where(eq(jobs.dedupKey, dedupKey)).limit(1);
    if (existing) {
      if (existing.payload.fingerprint !== fingerprint) throw new DomainError("conflict", 409);
      return { id: existing.payload.messageId, duplicate: true };
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
    return { id: messageId, duplicate: false };
  });
}
export async function setLocale(principal: Principal, input: unknown): Promise<void> {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
  const { locale } = z.object({ locale: z.enum(["en", "de"]).nullable() }).parse(input);
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
const issueInput = z.object({
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
    if (!isAction(action) || action === "agent.manage" || !held.includes(action))
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
const operatorInput = z.object({
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
const grantInput = z.object({
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
export async function setOperatorActive(principal: Principal, operatorId: string, input: unknown) {
  requireOwner(principal);
  const { active } = z.object({ active: z.boolean() }).parse(input);
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
