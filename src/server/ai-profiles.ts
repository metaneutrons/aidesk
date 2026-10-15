import { and, eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { aiDefaults, aiProfileWrite, aiTasks, isAiTask, type AiTask } from "../domain/ai";
import type { ConfigDiffEntry } from "../domain/configuration";
import { permits, type Principal } from "../domain/permissions";
import { submitChange, type ChangeOutcome, type Tx } from "./changes";
import { db } from "./db";
import { aiProfiles, audit, connections } from "./db/schema";
import { DomainError } from "./errors";
const id = z.uuid();
type Row = typeof aiProfiles.$inferSelect;
function readable(principal: Principal, project: string): void {
  if (!permits(principal, project, "config.read")) throw new DomainError("not_found", 404);
}
function invalid(path: string[], message: string): never {
  throw new ZodError([{ code: "custom", path, message }]);
}
function parseTask(value: string): AiTask {
  if (!isAiTask(value)) invalid(["task"], `One of ${aiTasks.join(", ")}`);
  return value;
}
// The profile of every task of the product: the one that was set, or version 0 with
// the defaults and no connection or model.
export async function listAiProfiles(principal: Principal, projectId: string) {
  const project = id.parse(projectId);
  readable(principal, project);
  const rows = await db().select().from(aiProfiles).where(eq(aiProfiles.projectId, project));
  return aiTasks.map((task) => {
    const row = rows.find((entry) => entry.task === task);
    return {
      task,
      version: row?.version ?? 0,
      connectionId: row?.connectionId ?? null,
      model: row?.model ?? null,
      timeoutSeconds: row?.timeoutSeconds ?? aiDefaults.timeoutSeconds,
      maxOutputTokens: row?.maxOutputTokens ?? aiDefaults.maxOutputTokens,
      dailyTokenBudget: row?.dailyTokenBudget ?? aiDefaults.dailyTokenBudget,
      enabled: row?.enabled ?? false,
    };
  });
}
// A profile may name only a connection to a model provider of its own project that
// is not disabled. Checked when the change is made and again when a proposal is
// decided, since the connection can have changed in between.
async function checkConnection(tx: Tx, project: string, connectionId: string): Promise<void> {
  const [connection] = await tx
    .select({ direction: connections.direction, status: connections.status })
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.projectId, project)));
  if (connection?.direction !== "ai")
    invalid(["connectionId"], "Not a connection to a model provider of this project");
  if (connection.status === "disabled") invalid(["connectionId"], "This connection is disabled");
}
const fields = [
  "connectionId",
  "model",
  "timeoutSeconds",
  "maxOutputTokens",
  "dailyTokenBudget",
  "enabled",
] as const;
export async function setAiProfile(
  principal: Principal,
  projectId: string,
  taskName: string,
  input: unknown,
  options: { validate?: boolean } = {},
): Promise<ChangeOutcome> {
  const project = id.parse(projectId);
  readable(principal, project);
  if (!permits(principal, project, "config.write")) throw new DomainError("forbidden", 403);
  const task = parseTask(taskName);
  const request = aiProfileWrite.parse(input);
  return submitChange(
    principal,
    project,
    {
      kind: "ai_profile.set",
      idempotencyKey: request.idempotencyKey,
      prepare: async (tx) => {
        const [row] = await tx
          .select()
          .from(aiProfiles)
          .where(and(eq(aiProfiles.projectId, project), eq(aiProfiles.task, task)))
          .for("update");
        if (request.expectedVersion !== (row?.version ?? 0))
          throw new DomainError("stale_version", 409);
        await checkConnection(tx, project, request.connectionId);
        const payload = {
          task,
          connectionId: request.connectionId,
          model: request.model,
          timeoutSeconds: request.timeoutSeconds,
          maxOutputTokens: request.maxOutputTokens,
          dailyTokenBudget: request.dailyTokenBudget,
          enabled: request.enabled,
        };
        const diff: ConfigDiffEntry[] = fields
          .filter((field) => row?.[field] !== payload[field])
          .map((field) => ({
            pointer: `/aiProfiles/${task}/${field}`,
            from: row?.[field] ?? null,
            to: payload[field],
          }));
        // Switching a profile on, or pointing a profile that is on at another
        // provider, decides where ticket content goes. Only a person who may
        // approve applies that; everyone else proposes it, also under `direct`.
        const approval =
          request.enabled && (!row?.enabled || row.connectionId !== request.connectionId);
        return {
          target: task,
          version: row?.version ?? 0,
          payload,
          diff,
          approval,
        };
      },
      apply: (tx, change) =>
        applyAiProfilePayload(tx, project, change.payload, principal.id, change.diff),
    },
    options,
  );
}
// Whether a proposal was made on a version of the profile that has been replaced.
export async function aiProfileProposalStale(
  tx: Tx,
  project: string,
  target: string | null,
  baseVersion: number,
): Promise<boolean> {
  const [row] = await tx
    .select({ version: aiProfiles.version })
    .from(aiProfiles)
    .where(and(eq(aiProfiles.projectId, project), eq(aiProfiles.task, target ?? "")))
    .for("update");
  return (row?.version ?? 0) !== baseVersion;
}
export async function applyAiProfilePayload(
  tx: Tx,
  project: string,
  payload: Record<string, unknown>,
  actor: string,
  diff: ConfigDiffEntry[],
): Promise<{ target: string; version: number }> {
  const task = parseTask(String(payload.task));
  const values = {
    connectionId: String(payload.connectionId),
    model: String(payload.model),
    timeoutSeconds: Number(payload.timeoutSeconds),
    maxOutputTokens: Number(payload.maxOutputTokens),
    dailyTokenBudget: Number(payload.dailyTokenBudget),
    enabled: payload.enabled === true,
  };
  await checkConnection(tx, project, values.connectionId);
  const [current]: (Row | undefined)[] = await tx
    .select()
    .from(aiProfiles)
    .where(and(eq(aiProfiles.projectId, project), eq(aiProfiles.task, task)))
    .for("update");
  const [saved] = current
    ? await tx
        .update(aiProfiles)
        .set({ ...values, version: current.version + 1, updatedAt: new Date() })
        .where(eq(aiProfiles.id, current.id))
        .returning({ version: aiProfiles.version })
    : await tx
        .insert(aiProfiles)
        .values({ projectId: project, task, ...values })
        .returning({ version: aiProfiles.version });
  if (!saved) throw new DomainError("conflict", 409);
  await tx.insert(audit).values({
    projectId: project,
    actorId: actor,
    action: "ai_profile.set",
    targetId: task,
    detail: { enabled: values.enabled, diff },
  });
  return { target: task, version: saved.version };
}
