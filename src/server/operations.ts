import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import {
  account,
  agents,
  audit,
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
  const [ticket] = await db()
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, id.parse(ticketId)), inArray(tickets.projectId, allowed)))
    .limit(1);
  if (!ticket) throw new DomainError("not_found", 404);
  const conversation = await db()
    .select()
    .from(messages)
    .where(eq(messages.ticketId, ticket.id))
    .orderBy(messages.createdAt);
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
