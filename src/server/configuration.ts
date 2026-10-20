import { redactRecord } from "../domain/audit";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { z, ZodError } from "zod";
import {
  configDecision,
  configDocument,
  configWrite,
  diffConfig,
  type ConfigDiffEntry,
  type ConfigDocument,
} from "../domain/configuration";
import { permits, type Principal } from "../domain/permissions";
import { limitsOf } from "../domain/response-clock";
import { junkSensitivityOf } from "../domain/junk";
import { autoResolveOf, replyPolicyOf } from "../domain/reply-policy";
import { db } from "./db";
import { applyConnectionPayload } from "./connections";
import { applyTextPayload, textProposalStale } from "./texts";
import { aiProfileProposalStale, applyAiProfilePayload } from "./ai-profiles";
import { applyWebhookPayload, emitEvent, webhookProposalStale } from "./webhooks";
import { audit, configChanges, connections, projects } from "./db/schema";
import { DomainError } from "./errors";
const id = z.uuid();
type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
type Row = typeof projects.$inferSelect;
export function configOf(row: Pick<Row, "name" | "color" | "defaultLanguage" | "settings">) {
  const settings = row.settings;
  const { warnHours, overdueHours } = limitsOf(settings);
  const reply = replyPolicyOf(settings);
  const auto = autoResolveOf(settings);
  return configDocument.parse({
    name: row.name,
    color: row.color,
    defaultLanguage: row.defaultLanguage === "de" ? "de" : "en",
    acknowledgements: settings.acknowledgements === true,
    portalLinks: settings.portalLinks === true,
    approvalPolicy: settings.approvalPolicy === "direct" ? "direct" : "review",
    outboundConnectionId:
      typeof settings.outboundConnectionId === "string" &&
      z.uuid().safeParse(settings.outboundConnectionId).success
        ? settings.outboundConnectionId
        : null,
    pauseOutgoing: settings.pauseOutgoing === true,
    warnHours,
    overdueHours,
    reopenMode: reply.mode,
    reopenDays: reply.days,
    autoResolveDays: auto.days,
    autoResolveReminderDays: auto.reminderDays,
    junkSensitivity: junkSensitivityOf(settings.junkSensitivity),
  });
}
function readable(principal: Principal, project: string): void {
  if (!permits(principal, project, "config.read")) throw new DomainError("not_found", 404);
}
// The configuration a person or an agent may read, with the version a writer
// has to name.
export async function getConfig(principal: Principal, projectId: string) {
  const project = id.parse(projectId);
  readable(principal, project);
  const [row] = await db().select().from(projects).where(eq(projects.id, project));
  if (!row) throw new DomainError("not_found", 404);
  return { slug: row.slug, version: row.configVersion, config: configOf(row) };
}
// A change applies once per version: everything proposed on an older version
// can no longer be activated.
export async function supersedeOlder(tx: Tx, project: string, version: number): Promise<void> {
  await tx
    .update(configChanges)
    .set({ status: "superseded", decidedAt: new Date() })
    .where(
      and(
        eq(configChanges.projectId, project),
        eq(configChanges.status, "pending"),
        eq(configChanges.kind, "config"),
        lt(configChanges.baseVersion, version),
      ),
    );
}
async function apply(tx: Tx, project: string, config: ConfigDocument, version: number) {
  const next = version + 1;
  await tx
    .update(projects)
    .set({
      name: config.name,
      color: config.color,
      defaultLanguage: config.defaultLanguage,
      settings: sqlMerge(config),
      configVersion: next,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, project));
  await supersedeOlder(tx, project, next);
  return next;
}
function sqlMerge(config: ConfigDocument) {
  const values = {
    acknowledgements: config.acknowledgements,
    portalLinks: config.portalLinks,
    approvalPolicy: config.approvalPolicy,
    outboundConnectionId: config.outboundConnectionId,
    pauseOutgoing: config.pauseOutgoing,
    warnHours: config.warnHours,
    overdueHours: config.overdueHours,
    reopenMode: config.reopenMode,
    reopenDays: config.reopenDays,
    autoResolveDays: config.autoResolveDays,
    autoResolveReminderDays: config.autoResolveReminderDays,
    junkSensitivity: config.junkSensitivity,
  };
  return sql`${projects.settings} || ${JSON.stringify(values)}::jsonb`;
}
export interface ConfigResult {
  // "unchanged": nothing to do; "applied": the configuration changed;
  // "proposed": a person with config.approve has to activate it.
  outcome: "unchanged" | "applied" | "proposed";
  version: number;
  changeId: string | null;
  diff: ConfigDiffEntry[];
  // True when nothing was written: the outcome says what a real write would do.
  validated: boolean;
}
// Replaces the editable configuration of a project. People with config.write
// apply it directly. An agent with config.write applies it when the project's
// approval policy is "direct" and proposes it otherwise. The approval policy
// itself is changed only by a person with config.approve.
export async function putConfig(
  principal: Principal,
  projectId: string,
  input: unknown,
  options: { validate?: boolean } = {},
): Promise<ConfigResult> {
  const project = id.parse(projectId);
  readable(principal, project);
  if (!permits(principal, project, "config.write")) throw new DomainError("forbidden", 403);
  const request = configWrite.parse(input);
  const run = async (tx: Tx): Promise<ConfigResult> => {
    const lock = options.validate ? undefined : "update";
    const query = tx.select().from(projects).where(eq(projects.id, project));
    const [row] = lock ? await query.for("update") : await query;
    if (!row) throw new DomainError("not_found", 404);
    if (request.idempotencyKey && !options.validate) {
      const [earlier] = await tx
        .select()
        .from(configChanges)
        .where(
          and(
            eq(configChanges.projectId, project),
            eq(configChanges.idempotencyKey, request.idempotencyKey),
          ),
        );
      if (earlier) {
        if (
          earlier.proposedBy !== principal.id ||
          !isDeepStrictEqual(earlier.payload, request.config)
        )
          throw new DomainError("idempotency_conflict", 409);
        return {
          outcome: earlier.status === "applied" ? "applied" : "proposed",
          version: earlier.appliedVersion ?? row.configVersion,
          changeId: earlier.id,
          diff: earlier.diff,
          validated: false,
        };
      }
    }
    if (request.expectedVersion !== row.configVersion) throw new DomainError("stale_version", 409);
    const outbound = request.config.outboundConnectionId;
    if (outbound !== null) {
      const [connection] = await tx
        .select({ direction: connections.direction, status: connections.status })
        .from(connections)
        .where(and(eq(connections.id, outbound), eq(connections.projectId, project)));
      if (connection?.direction !== "outbound" || connection.status === "disabled")
        throw new ZodError([
          {
            code: "custom",
            path: ["config", "outboundConnectionId"],
            message: "An outgoing connection of this project that is not disabled",
          },
        ]);
    }
    const current = configOf(row);
    const diff = diffConfig(current, request.config);
    if (diff.length === 0)
      return {
        outcome: "unchanged",
        version: row.configVersion,
        changeId: null,
        diff,
        validated: options.validate === true,
      };
    if (
      diff.some((entry) => entry.pointer === "/approvalPolicy") &&
      (principal.kind !== "human" || !permits(principal, project, "config.approve"))
    )
      throw new DomainError("forbidden", 403);
    const direct = principal.kind === "human" || current.approvalPolicy === "direct";
    if (options.validate)
      return {
        outcome: direct ? "applied" : "proposed",
        version: row.configVersion,
        changeId: null,
        diff,
        validated: true,
      };
    const base = {
      projectId: project,
      baseVersion: row.configVersion,
      proposedBy: principal.id,
      proposerKind: principal.kind,
      idempotencyKey: request.idempotencyKey ?? null,
      payload: request.config,
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
        action: "config.propose",
        targetId: change.id,
        detail: redactRecord({ baseVersion: row.configVersion, diff }),
      });
      await emitEvent(tx, project, "change.proposed", {
        changeId: change.id,
        kind: "config",
        target: null,
      });
      return {
        outcome: "proposed",
        version: row.configVersion,
        changeId: change.id,
        diff,
        validated: false,
      };
    }
    const version = await apply(tx, project, request.config, row.configVersion);
    const [change] = await tx
      .insert(configChanges)
      .values({ ...base, status: "applied", appliedVersion: version, decidedAt: new Date() })
      .returning({ id: configChanges.id });
    if (!change) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "config.apply",
      targetId: change.id,
      detail: redactRecord({ version, diff }),
    });
    return { outcome: "applied", version, changeId: change.id, diff, validated: false };
  };
  return db().transaction(run);
}
// Proposed and applied changes of a project, newest first.
export async function listConfigChanges(principal: Principal, projectId: string, status?: string) {
  const project = id.parse(projectId);
  readable(principal, project);
  const wanted = z
    .enum(["pending", "applied", "rejected", "superseded"])
    .optional()
    .parse(status ?? undefined);
  const rows = await db()
    .select()
    .from(configChanges)
    .where(
      wanted
        ? and(eq(configChanges.projectId, project), eq(configChanges.status, wanted))
        : eq(configChanges.projectId, project),
    )
    .orderBy(desc(configChanges.createdAt))
    .limit(100);
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    target: row.target,
    status: row.status,
    baseVersion: row.baseVersion,
    appliedVersion: row.appliedVersion,
    proposedBy: row.proposedBy,
    proposerKind: row.proposerKind,
    diff: row.diff,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    reason: row.reason,
    createdAt: row.createdAt,
  }));
}
type Proposal = typeof configChanges.$inferSelect;
// Whether a proposal on a connection, a text or a webhook was made on a version
// that has been replaced since. A new connection or webhook has no earlier version.
async function proposalStale(tx: Tx, project: string, proposal: Proposal): Promise<boolean> {
  if (proposal.kind === "text.set")
    return textProposalStale(tx, project, proposal.payload, proposal.baseVersion);
  if (proposal.kind === "ai_profile.set")
    return aiProfileProposalStale(tx, project, proposal.target, proposal.baseVersion);
  if (proposal.kind.startsWith("webhook.")) {
    if (proposal.kind === "webhook.create") return false;
    return webhookProposalStale(tx, project, proposal.target, proposal.baseVersion);
  }
  if (proposal.kind === "connection.create") return false;
  const [connection] = await tx
    .select({ version: connections.version })
    .from(connections)
    .where(and(eq(connections.id, proposal.target ?? ""), eq(connections.projectId, project)))
    .for("update");
  return connection?.version !== proposal.baseVersion;
}
async function applyProposal(
  tx: Tx,
  project: string,
  proposal: Proposal,
  actor: string,
): Promise<{ target: string; version: number }> {
  if (proposal.kind === "text.set")
    return applyTextPayload(tx, project, proposal.payload, actor, proposal.diff);
  if (proposal.kind === "ai_profile.set")
    return applyAiProfilePayload(tx, project, proposal.payload, actor, proposal.diff);
  if (proposal.kind.startsWith("webhook."))
    return applyWebhookPayload(
      tx,
      project,
      proposal.kind,
      proposal.target,
      proposal.payload,
      actor,
      proposal.diff,
    );
  const applied = await applyConnectionPayload(
    tx,
    project,
    proposal.kind,
    proposal.target,
    proposal.payload,
    actor,
    proposal.diff,
  );
  return { target: applied.connectionId, version: applied.version };
}
// A person with config.approve activates or rejects a proposal. A proposal on a
// version that has changed since is superseded and never applies.
export async function decideConfigChange(principal: Principal, changeId: string, input: unknown) {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
  const change = id.parse(changeId);
  const decision = configDecision.parse(input);
  const [found] = await db()
    .select({ projectId: configChanges.projectId })
    .from(configChanges)
    .where(eq(configChanges.id, change));
  if (!found) throw new DomainError("not_found", 404);
  readable(principal, found.projectId);
  if (!permits(principal, found.projectId, "config.approve"))
    throw new DomainError("forbidden", 403);
  const result = await db().transaction(async (tx) => {
    // The project first, as everywhere, so concurrent decisions queue up.
    const [row] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, found.projectId))
      .for("update");
    const [proposal] = await tx
      .select()
      .from(configChanges)
      .where(eq(configChanges.id, change))
      .for("update");
    if (!row || !proposal) throw new DomainError("not_found", 404);
    if (proposal.status !== "pending") return { error: new DomainError("conflict", 409) };
    const decided = {
      decidedBy: principal.id,
      decidedAt: new Date(),
      reason: decision.reason ?? null,
    };
    if (decision.decision === "reject") {
      await tx
        .update(configChanges)
        .set({ status: "rejected", ...decided })
        .where(eq(configChanges.id, change));
      await tx.insert(audit).values({
        projectId: row.id,
        actorId: principal.id,
        action: "config.reject",
        targetId: change,
        detail: redactRecord({ reason: decided.reason }),
      });
      return { value: { id: change, status: "rejected" as const, version: row.configVersion } };
    }
    if (proposal.kind !== "config") {
      // A change applies to the version of the thing it was made on.
      if (await proposalStale(tx, row.id, proposal)) {
        await tx
          .update(configChanges)
          .set({ status: "superseded", ...decided })
          .where(eq(configChanges.id, change));
        return { error: new DomainError("stale_version", 409) };
      }
      const applied = await applyProposal(tx, row.id, proposal, principal.id);
      await tx
        .update(configChanges)
        .set({
          status: "applied",
          appliedVersion: applied.version,
          target: applied.target,
          ...decided,
        })
        .where(eq(configChanges.id, change));
      await tx.insert(audit).values({
        projectId: row.id,
        actorId: principal.id,
        action: "config.approve",
        targetId: change,
        detail: redactRecord({ kind: proposal.kind, diff: proposal.diff }),
      });
      return { value: { id: change, status: "applied" as const, version: applied.version } };
    }
    if (proposal.baseVersion !== row.configVersion) {
      await tx
        .update(configChanges)
        .set({ status: "superseded", ...decided })
        .where(eq(configChanges.id, change));
      return { error: new DomainError("stale_version", 409) };
    }
    const config = configDocument.parse(proposal.payload);
    const version = await apply(tx, row.id, config, row.configVersion);
    await tx
      .update(configChanges)
      .set({ status: "applied", appliedVersion: version, ...decided })
      .where(eq(configChanges.id, change));
    await tx.insert(audit).values({
      projectId: row.id,
      actorId: principal.id,
      action: "config.approve",
      targetId: change,
      detail: redactRecord({ version, diff: proposal.diff }),
    });
    return { value: { id: change, status: "applied" as const, version } };
  });
  // Raised outside the transaction so that the marking as superseded is kept.
  if (result.error) throw result.error;
  return result.value;
}
