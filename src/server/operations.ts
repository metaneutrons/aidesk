import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  agents,
  audit,
  connections,
  jobs,
  memberships,
  messages,
  projects,
  tickets,
  user,
} from "./db/schema";
import { DomainError } from "./errors";
import { markdownHtml } from "./markdown";
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
    })
    .from(projects)
    .where(inArray(projects.id, allowed))
    .orderBy(projects.name);
}
export async function listTickets(principal: Principal, requested: string[] = []) {
  const allowed = allowedProjectIds(principal, "ticket.read");
  const filtered = requested.length ? requested.map((value) => id.parse(value)) : allowed;
  if (filtered.some((value) => !allowed.includes(value))) throw new DomainError("not_found", 404);
  if (filtered.length === 0) return [];
  return db()
    .select()
    .from(tickets)
    .where(inArray(tickets.projectId, filtered))
    .orderBy(sql`${tickets.pendingSince} asc nulls last`, desc(tickets.updatedAt))
    .limit(250);
}
export async function getTicket(principal: Principal, ticketId: string) {
  const allowed = allowedProjectIds(principal, "ticket.read");
  if (!allowed.length) throw new DomainError("not_found", 404);
  // One snapshot for ticket and messages. Read separately, a delivery that
  // commits in between returned the message as sent with the ticket still
  // open, and the desk stopped refreshing on that inconsistent state.
  const { ticket, conversation } = await db().transaction(
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
      return { ticket: found, conversation: rows };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  return {
    ticket,
    messages: conversation.map((message) => ({ ...message, html: markdownHtml(message.markdown) })),
    actions: principal.grants.find((grant) => grant.projectId === ticket.projectId)?.actions ?? [],
    sender: await senderIdentity(ticket.projectId),
    // The worker sends public replies to the requester only.
    recipients: [{ name: ticket.requesterName, address: ticket.requesterEmail }],
  };
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
