import { redactRecord } from "../domain/audit";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import type { ConfigDiffEntry } from "../domain/configuration";
import { permits, type Principal } from "../domain/permissions";
import {
  webhookCreate,
  webhookDisable,
  webhookUpdate,
  type WebhookEvent,
  type WebhookPayload,
} from "../domain/webhooks";
import { submitChange, type ChangeOutcome, type Tx } from "./changes";
import { seal } from "./crypto";
import { db } from "./db";
import { audit, jobs, webhookDeliveries, webhooks } from "./db/schema";
import { DomainError } from "./errors";
import { env } from "./env";
import { checkHost, developmentStack } from "./host-guard";
const id = z.uuid();
type Row = typeof webhooks.$inferSelect;
function manageable(principal: Principal, project: string): void {
  if (!permits(principal, project, "integration.manage")) throw new DomainError("not_found", 404);
}
function invalid(path: string[], message: string): never {
  throw new ZodError([{ code: "custom", path, message }]);
}
// An endpoint has to be HTTPS and reachable at an address the machine may use,
// like a connection. A development stack may use a plain or local endpoint when
// the webhook says so.
async function checkEndpoint(url: string, developmentOnly: boolean): Promise<void> {
  if (developmentOnly) {
    if (!developmentStack()) invalid(["developmentOnly"], "Only a development stack accepts this");
    return;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") invalid(["url"], "HTTPS is required");
  if (parsed.username !== "" || parsed.password !== "")
    invalid(["url"], "Credentials do not belong in the address");
  const verdict = await checkHost(parsed.hostname);
  if (verdict === "refused") invalid(["url"], "This host is not allowed");
  if (verdict === "unresolved") invalid(["url"], "This host does not resolve");
}
export async function listWebhooks(principal: Principal, projectId: string) {
  const project = id.parse(projectId);
  manageable(principal, project);
  const rows = await db()
    .select()
    .from(webhooks)
    .where(eq(webhooks.projectId, project))
    .orderBy(asc(webhooks.createdAt));
  const last = new Map<string, typeof webhookDeliveries.$inferSelect>();
  for (const row of rows) {
    const [delivery] = await db()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, row.id))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(1);
    if (delivery) last.set(row.id, delivery);
  }
  return rows.map((row) => {
    const delivery = last.get(row.id);
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      url: row.url,
      events: row.events,
      developmentOnly: row.developmentOnly,
      status: row.status,
      version: row.version,
      secretSet: true,
      lastDelivery: delivery
        ? {
            at: delivery.createdAt,
            event: delivery.event,
            outcome: delivery.outcome,
            responseStatus: delivery.responseStatus,
            code: delivery.code,
          }
        : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}
export async function listWebhookDeliveries(
  principal: Principal,
  projectId: string,
  webhookId: string,
) {
  const project = id.parse(projectId);
  manageable(principal, project);
  const [hook] = await db()
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.id, id.parse(webhookId)), eq(webhooks.projectId, project)));
  if (!hook) throw new DomainError("not_found", 404);
  return db()
    .select({
      id: webhookDeliveries.id,
      eventId: webhookDeliveries.eventId,
      event: webhookDeliveries.event,
      attempt: webhookDeliveries.attempt,
      outcome: webhookDeliveries.outcome,
      responseStatus: webhookDeliveries.responseStatus,
      code: webhookDeliveries.code,
      durationMs: webhookDeliveries.durationMs,
      createdAt: webhookDeliveries.createdAt,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, hook.id))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(100);
}
function fieldDiff(from: Record<string, unknown>, to: Record<string, unknown>): ConfigDiffEntry[] {
  return Object.keys(to)
    .filter((key) => !isDeepStrictEqual(from[key], to[key]))
    .map((key) => ({ pointer: `/${key}`, from: from[key] ?? null, to: to[key] ?? null }));
}
// Applies a change to a webhook inside a transaction. The payload carries the
// sealed secret, never the plain one.
export async function applyWebhookPayload(
  tx: Tx,
  project: string,
  kind: string,
  target: string | null,
  payload: Record<string, unknown>,
  actor: string,
  diff: ConfigDiffEntry[],
): Promise<{ target: string; version: number }> {
  if (kind === "webhook.create") {
    const [created] = await tx
      .insert(webhooks)
      .values({
        projectId: project,
        name: String(payload.name),
        url: String(payload.url),
        events: payload.events as string[],
        developmentOnly: payload.developmentOnly === true,
        secretCiphertext: String(payload.secret),
      })
      .returning({ id: webhooks.id, version: webhooks.version });
    if (!created) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: project,
      actorId: actor,
      action: "webhook.create",
      targetId: created.id,
      detail: redactRecord({ diff }),
    });
    return { target: created.id, version: created.version };
  }
  if (!target) throw new DomainError("conflict", 409);
  const [current] = await tx.select().from(webhooks).where(eq(webhooks.id, target));
  if (!current) throw new DomainError("not_found", 404);
  const set: Partial<typeof webhooks.$inferInsert> =
    kind === "webhook.disable"
      ? { status: "disabled" }
      : {
          ...(typeof payload.name === "string" ? { name: payload.name } : {}),
          ...(typeof payload.url === "string" ? { url: payload.url } : {}),
          ...(Array.isArray(payload.events) ? { events: payload.events as string[] } : {}),
          ...(typeof payload.developmentOnly === "boolean"
            ? { developmentOnly: payload.developmentOnly }
            : {}),
          ...(typeof payload.secret === "string" ? { secretCiphertext: payload.secret } : {}),
        };
  const [changed] = await tx
    .update(webhooks)
    .set({ ...set, version: current.version + 1, updatedAt: new Date() })
    .where(eq(webhooks.id, target))
    .returning({ id: webhooks.id, version: webhooks.version });
  if (!changed) throw new DomainError("conflict", 409);
  await tx.insert(audit).values({
    projectId: project,
    actorId: actor,
    action: kind,
    targetId: target,
    detail: redactRecord({ diff }),
  });
  return { target: changed.id, version: changed.version };
}
// Whether a proposal on a webhook was made on a version that has been replaced.
export async function webhookProposalStale(
  tx: Tx,
  project: string,
  target: string | null,
  baseVersion: number,
): Promise<boolean> {
  const [row] = await tx
    .select({ version: webhooks.version })
    .from(webhooks)
    .where(and(eq(webhooks.id, target ?? ""), eq(webhooks.projectId, project)))
    .for("update");
  return row?.version !== baseVersion;
}
const sealed = (secret: string) => seal(secret, env().ENCRYPTION_KEY);
async function submit(
  principal: Principal,
  projectId: string,
  target: string | null,
  plan: {
    kind: "webhook.create" | "webhook.update" | "webhook.disable";
    expectedVersion: number | null;
    idempotencyKey: string | undefined;
    build: (row: Row | null) => { payload: Record<string, unknown>; diff: ConfigDiffEntry[] };
  },
  options: { validate?: boolean },
): Promise<ChangeOutcome> {
  const project = id.parse(projectId);
  manageable(principal, project);
  return submitChange(
    principal,
    project,
    {
      kind: plan.kind,
      idempotencyKey: plan.idempotencyKey,
      prepare: async (tx) => {
        let row: Row | null = null;
        if (target) {
          [row = null] = await tx
            .select()
            .from(webhooks)
            .where(and(eq(webhooks.id, id.parse(target)), eq(webhooks.projectId, project)))
            .for("update");
          if (!row) throw new DomainError("not_found", 404);
          if (plan.expectedVersion !== row.version) throw new DomainError("stale_version", 409);
        }
        return { target: row?.id ?? null, version: row?.version ?? null, ...plan.build(row) };
      },
      apply: (tx, change) =>
        applyWebhookPayload(
          tx,
          project,
          plan.kind,
          change.target,
          change.payload,
          principal.id,
          change.diff,
        ),
    },
    options,
  );
}
export async function createWebhook(
  principal: Principal,
  projectId: string,
  input: unknown,
  options: { validate?: boolean } = {},
) {
  const request = webhookCreate.parse(input);
  await checkEndpoint(request.url, request.developmentOnly);
  return submit(
    principal,
    projectId,
    null,
    {
      kind: "webhook.create",
      expectedVersion: null,
      idempotencyKey: request.idempotencyKey,
      build: () => ({
        payload: {
          name: request.name,
          url: request.url,
          events: request.events,
          developmentOnly: request.developmentOnly,
          secret: sealed(request.secret),
        },
        diff: [
          { pointer: "/name", from: null, to: request.name },
          { pointer: "/url", from: null, to: request.url },
          { pointer: "/events", from: null, to: request.events },
          { pointer: "/developmentOnly", from: null, to: request.developmentOnly },
          { pointer: "/secret", from: "unset", to: "set" },
        ],
      }),
    },
    options,
  );
}
export async function updateWebhook(
  principal: Principal,
  projectId: string,
  webhookId: string,
  input: unknown,
  options: { validate?: boolean } = {},
) {
  const request = webhookUpdate.parse(input);
  const project = id.parse(projectId);
  manageable(principal, project);
  const [existing] = await db()
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, id.parse(webhookId)), eq(webhooks.projectId, project)));
  if (!existing) throw new DomainError("not_found", 404);
  // The endpoint is checked as it will be after the change, before the write
  // starts, because resolving a host takes a moment.
  await checkEndpoint(
    request.url ?? existing.url,
    request.developmentOnly ?? existing.developmentOnly,
  );
  return submit(
    principal,
    projectId,
    webhookId,
    {
      kind: "webhook.update",
      expectedVersion: request.expectedVersion,
      idempotencyKey: request.idempotencyKey,
      build: (row) => {
        if (!row) throw new DomainError("not_found", 404);
        const wanted: Record<string, unknown> = {
          ...(request.name !== undefined ? { name: request.name } : {}),
          ...(request.url !== undefined ? { url: request.url } : {}),
          ...(request.events !== undefined ? { events: request.events } : {}),
          ...(request.developmentOnly !== undefined
            ? { developmentOnly: request.developmentOnly }
            : {}),
        };
        const diff = [
          ...fieldDiff(row, wanted),
          ...(request.secret !== undefined
            ? [{ pointer: "/secret", from: "set", to: "replaced" }]
            : []),
        ];
        return {
          payload: { ...wanted, ...(request.secret ? { secret: sealed(request.secret) } : {}) },
          diff,
        };
      },
    },
    options,
  );
}
export async function disableWebhook(
  principal: Principal,
  projectId: string,
  webhookId: string,
  input: unknown,
  options: { validate?: boolean } = {},
) {
  const request = webhookDisable.parse(input);
  return submit(
    principal,
    projectId,
    webhookId,
    {
      kind: "webhook.disable",
      expectedVersion: request.expectedVersion,
      idempotencyKey: request.idempotencyKey,
      build: (row) => ({
        payload: {},
        diff:
          row && row.status !== "disabled"
            ? [{ pointer: "/status", from: row.status, to: "disabled" }]
            : [],
      }),
    },
    options,
  );
}
// Queues one delivery of an event to every active webhook of the project that
// subscribed to it, inside the transaction that made the event happen, so an
// event is neither lost nor announced for a change that was rolled back.
export async function emitEvent(
  tx: Tx,
  projectId: string,
  type: WebhookEvent,
  data: Record<string, unknown>,
): Promise<void> {
  const hooks = await tx
    .select({ id: webhooks.id, events: webhooks.events })
    .from(webhooks)
    .where(and(eq(webhooks.projectId, projectId), eq(webhooks.status, "active")));
  const subscribed = hooks.filter((hook) => hook.events.includes(type));
  if (subscribed.length === 0) return;
  const event: WebhookPayload = {
    id: randomUUID(),
    type,
    at: new Date().toISOString(),
    projectId,
    data,
  };
  await tx.insert(jobs).values(
    subscribed.map((hook) => ({
      projectId,
      type: "webhook.deliver",
      dedupKey: `webhook:${hook.id}:${event.id}`,
      payload: { webhookId: hook.id, event },
    })),
  );
}
// A delivery of a test event to one webhook, to see that the endpoint answers.
export async function pingWebhook(principal: Principal, projectId: string, webhookId: string) {
  const project = id.parse(projectId);
  manageable(principal, project);
  return db().transaction(async (tx) => {
    const [hook] = await tx
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, id.parse(webhookId)), eq(webhooks.projectId, project)));
    if (!hook) throw new DomainError("not_found", 404);
    if (hook.status !== "active") throw new DomainError("conflict", 409);
    const event: WebhookPayload = {
      id: randomUUID(),
      type: "ping",
      at: new Date().toISOString(),
      projectId: project,
      data: { webhookId: hook.id },
    };
    await tx.insert(jobs).values({
      projectId: project,
      type: "webhook.deliver",
      dedupKey: `webhook:${hook.id}:${event.id}`,
      payload: { webhookId: hook.id, event },
    });
    return { eventId: event.id };
  });
}
