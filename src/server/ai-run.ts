import { APICallError } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { estimateFileTokens, estimateTokens, type AiFailure, type AiTask } from "../domain/ai";
import { aiSecret } from "../domain/connections";
import { unseal } from "./crypto";
import { db } from "./db";
import { aiBudgets, aiProfiles, aiRuns, connections } from "./db/schema";
import { env } from "./env";
import { generate as callProvider, type CallFile, type Generate } from "./ai-provider";
import { checkHost } from "./host-guard";
// The one boundary through which a task of the product asks a model. A run needs a
// profile that is on and a connection that is ready, holds its share of the daily
// budget before the call and settles it after, ends at the timeout of the profile,
// asks for no more output than the profile allows, and keeps a record of what it
// used and how it ended, without the prompt, the ticket content or the answer.
//
// A call is made once. When its outcome is unknown (a timeout, a failure of the
// network or of the provider) the run does not repeat it and does not try another
// provider, because the request may have been accepted and may have cost something,
// and the tokens it held stay charged. A call that the provider refused before it
// did anything (a status 4xx) gives its share back.
export interface AiRequest {
  projectId: string;
  task: AiTask;
  system: string;
  prompt: string;
  // Images or PDFs the model reads with the prompt; they count against the budget.
  files?: CallFile[];
  actor: { id: string; kind: "human" | "agent" | "system" };
}
export type AiOutcome =
  | {
      ok: true;
      text: string;
      // The model that answered, as the profile named it.
      model: string;
      // The answer reached the cap of the profile and was cut by the provider.
      truncated: boolean;
      usage: { inputTokens: number | null; outputTokens: number | null };
      runId: string;
    }
  | { ok: false; code: AiFailure; runId: string | null };
export interface AiDeps {
  generate?: Generate;
  now?: () => Date;
}
const kinds = ["anthropic", "openai", "google"] as const;
type Kind = (typeof kinds)[number];
const isKind = (value: string): value is Kind => kinds.some((kind) => kind === value);
// A provider that refused the request before it did anything.
function refused(error: unknown): boolean {
  return (
    APICallError.isInstance(error) &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 408
  );
}
function timedOut(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}
export async function runAiTask(request: AiRequest, deps: AiDeps = {}): Promise<AiOutcome> {
  const started = Date.now();
  const generate = deps.generate ?? callProvider;
  const record = async (
    outcome: string,
    extra: {
      profileVersion?: number;
      connectionId?: string;
      model?: string;
      inputTokens?: number | null;
      outputTokens?: number | null;
    } = {},
  ): Promise<string> => {
    const [row] = await db()
      .insert(aiRuns)
      .values({
        projectId: request.projectId,
        task: request.task,
        outcome,
        durationMs: Date.now() - started,
        actorKind: request.actor.kind,
        actorId: request.actor.id,
        profileVersion: extra.profileVersion ?? null,
        connectionId: extra.connectionId ?? null,
        model: extra.model ?? null,
        inputTokens: extra.inputTokens ?? null,
        outputTokens: extra.outputTokens ?? null,
      })
      .returning({ id: aiRuns.id });
    return row?.id ?? "";
  };
  const fail = async (code: AiFailure, extra = {}): Promise<AiOutcome> => ({
    ok: false,
    code,
    runId: await record(code, extra),
  });
  const [profile] = await db()
    .select()
    .from(aiProfiles)
    .where(and(eq(aiProfiles.projectId, request.projectId), eq(aiProfiles.task, request.task)));
  if (!profile) return fail("ai_not_configured");
  const known = { profileVersion: profile.version, model: profile.model };
  if (!profile.enabled) return fail("ai_disabled", known);
  const [connection] = await db()
    .select()
    .from(connections)
    .where(
      and(eq(connections.id, profile.connectionId), eq(connections.projectId, request.projectId)),
    );
  const withConnection = { ...known, connectionId: profile.connectionId };
  if (
    connection?.direction !== "ai" ||
    connection.status !== "ready" ||
    !isKind(connection.kind) ||
    !connection.secretCiphertext
  )
    return fail("ai_not_configured", withConnection);
  const endpoint =
    typeof connection.config.endpoint === "string" ? connection.config.endpoint : undefined;
  // An address of its own is checked again, so a name that has come to point
  // somewhere refused is not called.
  if (endpoint !== undefined && connection.config.developmentOnly !== true) {
    if ((await checkHost(new URL(endpoint).hostname)) !== "allowed")
      return fail("ai_not_configured", withConnection);
  }
  const secret = aiSecret.safeParse(
    JSON.parse(unseal(connection.secretCiphertext, env().ENCRYPTION_KEY)),
  );
  if (!secret.success) return fail("ai_not_configured", withConnection);
  // The share of the budget this run holds while it runs: the input as estimated and
  // the longest answer the profile allows.
  const held =
    estimateTokens(request.system) +
    estimateTokens(request.prompt) +
    (request.files ?? []).reduce(
      (sum, file) => sum + estimateFileTokens(file.mediaType, file.data.length),
      0,
    ) +
    profile.maxOutputTokens;
  const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  if (held > profile.dailyTokenBudget) return fail("ai_budget_exceeded", withConnection);
  const [reserved] = await db()
    .insert(aiBudgets)
    .values({ projectId: request.projectId, task: request.task, day, charged: held })
    .onConflictDoUpdate({
      target: [aiBudgets.projectId, aiBudgets.task, aiBudgets.day],
      set: { charged: sql`${aiBudgets.charged} + ${held}` },
      setWhere: sql`${aiBudgets.charged} + ${held} <= ${profile.dailyTokenBudget}`,
    })
    .returning({ charged: aiBudgets.charged });
  if (!reserved) return fail("ai_budget_exceeded", withConnection);
  const adjust = (delta: number) =>
    db()
      .update(aiBudgets)
      .set({ charged: sql`greatest(${aiBudgets.charged} + ${delta}, 0)` })
      .where(
        and(
          eq(aiBudgets.projectId, request.projectId),
          eq(aiBudgets.task, request.task),
          eq(aiBudgets.day, day),
        ),
      );
  try {
    const answer = await generate({
      kind: connection.kind,
      endpoint,
      apiKey: secret.data.apiKey,
      model: profile.model,
      system: request.system,
      prompt: request.prompt,
      files: request.files,
      maxOutputTokens: profile.maxOutputTokens,
      timeoutMs: profile.timeoutSeconds * 1000,
    });
    const inputTokens = answer.usage.inputTokens ?? null;
    const outputTokens = answer.usage.outputTokens ?? null;
    // What the provider counted settles the share; when it did not say, the share
    // that was held stays charged.
    const used = answer.usage.totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0);
    if (used > 0) await adjust(used - held);
    return {
      ok: true,
      text: answer.text,
      model: profile.model,
      truncated: answer.finishReason === "length",
      usage: { inputTokens, outputTokens },
      runId: await record("ok", { ...withConnection, inputTokens, outputTokens }),
    };
  } catch (error) {
    if (refused(error)) {
      await adjust(-held);
      return fail("ai_provider_error", withConnection);
    }
    return fail(timedOut(error) ? "ai_timeout" : "ai_provider_error", withConnection);
  }
}
