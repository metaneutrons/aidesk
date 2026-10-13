import { isDeepStrictEqual } from "node:util";
import { ImapFlow } from "imapflow";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import nodemailer from "nodemailer";
import { and, asc, eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import {
  cloudflareInboundConfig,
  cloudflareInboundSecret,
  cloudflareOutboundConfig,
  cloudflareOutboundSecret,
  connectionDisable,
  connectionTypes,
  parseConnectionCreate,
  connectionUpdate,
  imapConfig,
  imapSecret,
  smtpConfig,
  smtpSecret,
  typeKey,
  type ConnectionTypeKey,
} from "../domain/connections";
import { hostRefused } from "../domain/hosts";
import { permits, type Principal } from "../domain/permissions";
import type { ConfigDiffEntry } from "../domain/configuration";
import { seal, unseal } from "./crypto";
import { db } from "./db";
import { audit, configChanges, connections, projects } from "./db/schema";
import { DomainError } from "./errors";
import { env } from "./env";
const id = z.uuid();
type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
type Row = typeof connections.$inferSelect;
const developmentStack = () =>
  process.env.NODE_ENV === "development" && process.env.DEV_BOOTSTRAP === "true";
function manageable(principal: Principal, project: string): void {
  if (!permits(principal, project, "integration.manage")) throw new DomainError("not_found", 404);
}
// An error in the request body, with the field named as a JSON pointer.
function invalid(path: (string | number)[], message: string): never {
  throw new ZodError([{ code: "custom", path, message }]);
}
export function connectionView(row: Row, outboundId: unknown) {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    direction: row.direction,
    name: row.name,
    status: row.status,
    lastErrorCode: row.lastErrorCode,
    version: row.version,
    config: row.config,
    secretSet: row.secretCiphertext !== null,
    usedForOutgoingMail: row.direction === "outbound" && outboundId === row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export async function listConnections(principal: Principal, projectId: string) {
  const project = id.parse(projectId);
  manageable(principal, project);
  const [row] = await db()
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, project));
  if (!row) throw new DomainError("not_found", 404);
  const rows = await db()
    .select()
    .from(connections)
    .where(eq(connections.projectId, project))
    .orderBy(asc(connections.createdAt));
  return rows.map((entry) => connectionView(entry, row.settings.outboundConnectionId));
}
// What a definition has to satisfy on top of its field types: the transport
// rules the adapters enforce, so a connection that is saved can be used, and
// the hosts a connection may not point at. A development stack may use plain
// connections to its local services.
function checkDefinition(key: ConnectionTypeKey, config: Record<string, unknown>) {
  const development = developmentStack();
  if (config.developmentOnly === true && !development)
    invalid(["config", "developmentOnly"], "Only a development stack accepts this");
  const plain = config.developmentOnly === true;
  if (plain) return;
  if (key === "imap:inbound") {
    if (config.secure !== true) invalid(["config", "secure"], "TLS is required");
    if (hostRefused(String(config.host))) invalid(["config", "host"], "This host is not allowed");
  }
  if (key === "smtp:outbound") {
    if (config.secure !== true && config.port !== 587)
      invalid(["config", "port"], "Use TLS, or port 587 with STARTTLS");
    if (hostRefused(String(config.host))) invalid(["config", "host"], "This host is not allowed");
  }
  if (key === "cloudflare:inbound") {
    const url = new URL(String(config.endpoint));
    if (url.protocol !== "https:") invalid(["config", "endpoint"], "HTTPS is required");
    if (hostRefused(url.hostname)) invalid(["config", "endpoint"], "This host is not allowed");
  }
}
function parseConfig(key: ConnectionTypeKey, value: unknown): Record<string, unknown> {
  const parsed: Record<string, unknown> = connectionTypes[key].config.parse(value);
  checkDefinition(key, parsed);
  return parsed;
}
function parseSecret(key: ConnectionTypeKey, value: unknown): Record<string, unknown> {
  const parsed: Record<string, unknown> = connectionTypes[key].secret.parse(value);
  return parsed;
}
const sealed = (secret: Record<string, unknown>) =>
  seal(JSON.stringify(secret), env().ENCRYPTION_KEY);
function fieldDiff(
  prefix: string,
  from: Record<string, unknown>,
  to: Record<string, unknown>,
): ConfigDiffEntry[] {
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
  return keys
    .filter((key) => !isDeepStrictEqual(from[key], to[key]))
    .map((key) => ({ pointer: `${prefix}/${key}`, from: from[key] ?? null, to: to[key] ?? null }));
}
export interface ConnectionResult {
  outcome: "unchanged" | "applied" | "proposed";
  connectionId: string | null;
  version: number | null;
  changeId: string | null;
  diff: ConfigDiffEntry[];
  validated: boolean;
}
interface Plan {
  kind: "connection.create" | "connection.update" | "connection.disable";
  // Version the writer read, for update and disable.
  expectedVersion: number | null;
  idempotencyKey: string | undefined;
  // What the change does to the stored row, and the payload that a proposal keeps.
  build: (row: Row | null) => { payload: Record<string, unknown>; diff: ConfigDiffEntry[] };
}
// Applies a change to a connection inside a transaction. The payload carries
// the sealed secret, never the plain one.
export async function applyConnectionPayload(
  tx: Tx,
  project: string,
  kind: string,
  target: string | null,
  payload: Record<string, unknown>,
  actor: string,
  diff: ConfigDiffEntry[],
): Promise<{ connectionId: string; version: number }> {
  if (kind === "connection.create") {
    const [created] = await tx
      .insert(connections)
      .values({
        projectId: project,
        kind: String(payload.kind),
        direction: String(payload.direction),
        name: String(payload.name),
        config: payload.config as Record<string, unknown>,
        secretCiphertext: typeof payload.secret === "string" ? payload.secret : null,
        status: "draft",
      })
      .returning({ id: connections.id, version: connections.version });
    if (!created) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: project,
      actorId: actor,
      action: "connection.create",
      targetId: created.id,
      detail: { diff },
    });
    return { connectionId: created.id, version: created.version };
  }
  if (!target) throw new DomainError("conflict", 409);
  const set: Partial<typeof connections.$inferInsert> =
    kind === "connection.disable"
      ? { status: "disabled" }
      : {
          // A changed definition has to pass a test before it is used again.
          status: "draft",
          lastErrorCode: null,
          ...(typeof payload.name === "string" ? { name: payload.name } : {}),
          ...(payload.config ? { config: payload.config as Record<string, unknown> } : {}),
          ...(typeof payload.secret === "string" ? { secretCiphertext: payload.secret } : {}),
        };
  const [current] = await tx.select().from(connections).where(eq(connections.id, target));
  if (!current) throw new DomainError("not_found", 404);
  const [changed] = await tx
    .update(connections)
    .set({ ...set, version: current.version + 1, updatedAt: new Date() })
    .where(eq(connections.id, target))
    .returning({ id: connections.id, version: connections.version });
  if (!changed) throw new DomainError("conflict", 409);
  await tx.insert(audit).values({
    projectId: project,
    actorId: actor,
    action: kind,
    targetId: target,
    detail: { diff },
  });
  return { connectionId: changed.id, version: changed.version };
}
// The one path of every write: serialized per project, idempotent, checked
// against the version that was read, and either applied or kept as a proposal,
// by the same rule as the project configuration.
async function submit(
  principal: Principal,
  projectId: string,
  target: string | null,
  plan: Plan,
  options: { validate?: boolean },
): Promise<ConnectionResult> {
  const project = id.parse(projectId);
  manageable(principal, project);
  return db().transaction(async (tx) => {
    const [owner] = await tx
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, project))
      .for("update");
    if (!owner) throw new DomainError("not_found", 404);
    if (plan.idempotencyKey && !options.validate) {
      const [earlier] = await tx
        .select()
        .from(configChanges)
        .where(
          and(
            eq(configChanges.projectId, project),
            eq(configChanges.idempotencyKey, plan.idempotencyKey),
          ),
        );
      if (earlier) {
        if (earlier.proposedBy !== principal.id || earlier.kind !== plan.kind)
          throw new DomainError("idempotency_conflict", 409);
        return {
          outcome: earlier.status === "applied" ? "applied" : "proposed",
          connectionId: earlier.target,
          version: earlier.appliedVersion,
          changeId: earlier.id,
          diff: earlier.diff,
          validated: false,
        };
      }
    }
    let row: Row | null = null;
    if (target) {
      [row = null] = await tx
        .select()
        .from(connections)
        .where(and(eq(connections.id, id.parse(target)), eq(connections.projectId, project)))
        .for("update");
      if (!row) throw new DomainError("not_found", 404);
      if (plan.expectedVersion !== row.version) throw new DomainError("stale_version", 409);
    }
    const { payload, diff } = plan.build(row);
    if (diff.length === 0)
      return {
        outcome: "unchanged",
        connectionId: row?.id ?? null,
        version: row?.version ?? null,
        changeId: null,
        diff,
        validated: options.validate === true,
      };
    const direct = principal.kind === "human" || owner.settings.approvalPolicy === "direct";
    if (options.validate)
      return {
        outcome: direct ? "applied" : "proposed",
        connectionId: row?.id ?? null,
        version: row?.version ?? null,
        changeId: null,
        diff,
        validated: true,
      };
    const base = {
      projectId: project,
      kind: plan.kind,
      target,
      baseVersion: row?.version ?? 0,
      proposedBy: principal.id,
      proposerKind: principal.kind,
      idempotencyKey: plan.idempotencyKey ?? null,
      payload,
      diff,
    };
    if (!direct) {
      const [change] = await tx
        .insert(configChanges)
        .values({ ...base, status: "pending" })
        .returning({ id: configChanges.id });
      if (!change) throw new DomainError("conflict", 409);
      await tx.insert(audit).values({
        projectId: project,
        actorId: principal.id,
        action: "connection.propose",
        targetId: change.id,
        detail: { kind: plan.kind, target, diff },
      });
      return {
        outcome: "proposed",
        connectionId: row?.id ?? null,
        version: row?.version ?? null,
        changeId: change.id,
        diff,
        validated: false,
      };
    }
    const applied = await applyConnectionPayload(
      tx,
      project,
      plan.kind,
      target,
      payload,
      principal.id,
      diff,
    );
    const [change] = await tx
      .insert(configChanges)
      .values({
        ...base,
        target: applied.connectionId,
        status: "applied",
        appliedVersion: applied.version,
        decidedAt: new Date(),
      })
      .returning({ id: configChanges.id });
    if (!change) throw new DomainError("conflict", 409);
    return {
      outcome: "applied",
      connectionId: applied.connectionId,
      version: applied.version,
      changeId: change.id,
      diff,
      validated: false,
    };
  });
}
export async function createConnection(
  principal: Principal,
  projectId: string,
  input: unknown,
  options: { validate?: boolean } = {},
) {
  const request = parseConnectionCreate(input);
  const key = typeKey(request.kind, request.direction);
  if (!key) throw new DomainError("invalid_input", 400);
  const config = parseConfig(key, request.config);
  const secret = request.secret === undefined ? null : parseSecret(key, request.secret);
  return submit(
    principal,
    projectId,
    null,
    {
      kind: "connection.create",
      expectedVersion: null,
      idempotencyKey: request.idempotencyKey,
      build: () => ({
        payload: {
          kind: request.kind,
          direction: request.direction,
          name: request.name,
          config,
          secret: secret ? sealed(secret) : null,
        },
        diff: [
          { pointer: "/kind", from: null, to: request.kind },
          { pointer: "/direction", from: null, to: request.direction },
          { pointer: "/name", from: null, to: request.name },
          ...fieldDiff("/config", {}, config),
          ...(secret ? [{ pointer: "/secret", from: "unset", to: "set" }] : []),
        ],
      }),
    },
    options,
  );
}
export async function updateConnection(
  principal: Principal,
  projectId: string,
  connectionId: string,
  input: unknown,
  options: { validate?: boolean } = {},
) {
  const request = connectionUpdate.parse(input);
  return submit(
    principal,
    projectId,
    connectionId,
    {
      kind: "connection.update",
      expectedVersion: request.expectedVersion,
      idempotencyKey: request.idempotencyKey,
      build: (row) => {
        if (!row) throw new DomainError("not_found", 404);
        const key = typeKey(row.kind, row.direction);
        if (!key) throw new DomainError("conflict", 409);
        const config = request.config === undefined ? undefined : parseConfig(key, request.config);
        const secret = request.secret === undefined ? undefined : parseSecret(key, request.secret);
        const diff: ConfigDiffEntry[] = [
          ...(request.name !== undefined && request.name !== row.name
            ? [{ pointer: "/name", from: row.name, to: request.name }]
            : []),
          ...(config ? fieldDiff("/config", row.config, config) : []),
          // A replaced secret is a change even if it were equal; it is not compared.
          ...(secret ? [{ pointer: "/secret", from: "set", to: "replaced" }] : []),
        ];
        return {
          payload: {
            ...(request.name !== undefined ? { name: request.name } : {}),
            ...(config ? { config } : {}),
            ...(secret ? { secret: sealed(secret) } : {}),
          },
          diff,
        };
      },
    },
    options,
  );
}
export async function disableConnection(
  principal: Principal,
  projectId: string,
  connectionId: string,
  input: unknown,
  options: { validate?: boolean } = {},
) {
  const request = connectionDisable.parse(input);
  return submit(
    principal,
    projectId,
    connectionId,
    {
      kind: "connection.disable",
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
// What went wrong, as a code that carries neither a host nor a credential.
export function failureCode(error: unknown): string {
  const info = error as {
    code?: unknown;
    authenticationFailed?: unknown;
    cause?: { code?: unknown };
  };
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const code = text(info.code) || text(info.cause?.code);
  if (info.authenticationFailed === true || code === "EAUTH" || code === "AUTHENTICATIONFAILED")
    return "auth_failed";
  if (
    ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "ESOCKET", "ECONNECTION"].includes(
      code,
    )
  )
    return "connect_failed";
  if (["ETIMEDOUT", "ETIMEOUT", "TimeoutError"].includes(code)) return "timeout";
  if (/CERT|TLS|SSL/i.test(code)) return "tls_failed";
  const name = error instanceof Error ? error.name : "";
  if (name === "InvalidAccessKeyId" || name === "SignatureDoesNotMatch" || name === "AccessDenied")
    return "auth_failed";
  if (name === "NoSuchBucket") return "not_found";
  if (name === "TimeoutError") return "timeout";
  return "failed";
}
const timeout = 15_000;
async function probe(row: Row): Promise<void> {
  const key = typeKey(row.kind, row.direction);
  if (!key) throw new Error("unknown_kind");
  const secretText = row.secretCiphertext
    ? (JSON.parse(unseal(row.secretCiphertext, env().ENCRYPTION_KEY)) as unknown)
    : undefined;
  if (key === "imap:inbound") {
    const config = imapConfig.parse(row.config);
    const secret = imapSecret.parse(secretText);
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: secret.pass },
      logger: false,
      tls: { rejectUnauthorized: true },
      socketTimeout: timeout,
      greetingTimeout: timeout,
      connectionTimeout: timeout,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock(config.mailbox);
      lock.release();
    } finally {
      await client.logout().catch(() => undefined);
    }
    return;
  }
  if (key === "cloudflare:inbound") {
    const config = cloudflareInboundConfig.parse(row.config);
    const secret = cloudflareInboundSecret.parse(secretText);
    const client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: secret,
    });
    await client.send(new ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: 1 }), {
      abortSignal: AbortSignal.timeout(timeout),
    });
    return;
  }
  if (key === "smtp:outbound") {
    const config = smtpConfig.parse(row.config);
    const secret = secretText === undefined ? undefined : smtpSecret.parse(secretText);
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.developmentOnly && !config.secure,
      auth: secret ? { user: secret.user, pass: secret.pass } : undefined,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    });
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
    return;
  }
  // Cloudflare outbound: the token has to be active. Whether it may send is
  // known only by sending, which a test does not do.
  const config = cloudflareOutboundConfig.parse(row.config);
  const secret = cloudflareOutboundSecret.parse(secretText);
  for (const path of [`/accounts/${config.accountId}/tokens/verify`, "/user/tokens/verify"]) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { Authorization: `Bearer ${secret.apiToken}` },
      signal: AbortSignal.timeout(timeout),
    });
    const body = (await response.json().catch(() => null)) as {
      success?: boolean;
      result?: { status?: string };
    } | null;
    if (response.ok && body?.success === true && body.result?.status === "active") return;
  }
  throw Object.assign(new Error("token"), { authenticationFailed: true });
}
// Checks that the connection can be used, and records the outcome: ready, or
// degraded with a code. A result for a version that has changed in the meantime
// is dropped. The test sends no mail and reads none.
export async function testConnection(
  principal: Principal,
  projectId: string,
  connectionId: string,
) {
  const project = id.parse(projectId);
  manageable(principal, project);
  const [row] = await db()
    .select()
    .from(connections)
    .where(and(eq(connections.id, id.parse(connectionId)), eq(connections.projectId, project)));
  if (!row) throw new DomainError("not_found", 404);
  if (row.status === "disabled") throw new DomainError("conflict", 409);
  let code: string | null = null;
  try {
    await probe(row);
  } catch (error) {
    code = failureCode(error);
  }
  const [updated] = await db()
    .update(connections)
    .set({
      status: code === null ? "ready" : "degraded",
      lastErrorCode: code,
      updatedAt: new Date(),
    })
    .where(and(eq(connections.id, row.id), eq(connections.version, row.version)))
    .returning({ status: connections.status });
  if (!updated) throw new DomainError("stale_version", 409);
  await db()
    .insert(audit)
    .values({
      projectId: project,
      actorId: principal.id,
      action: "connection.test",
      targetId: row.id,
      detail: { result: code ?? "ready" },
    });
  return { id: row.id, status: updated.status, lastErrorCode: code };
}
