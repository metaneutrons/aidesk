import { APICallError, type ModelMessage } from "ai";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  estimateFileTokens,
  estimateTokens,
  fallbackCodes,
  type AiFailure,
  type AiTask,
} from "../domain/ai";
import { aiSecret } from "../domain/connections";
import { unseal } from "./crypto";
import { db } from "./db";
import { aiBudgets, aiProfiles, aiRuns, connections } from "./db/schema";
import { env } from "./env";
import {
  generate as callProvider,
  type CallFile,
  type CallTool,
  type Generate,
  type ToolCall,
} from "./ai-provider";
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
  // A conversation with tools: what was said and called so far, and the tools that the
  // model may call. Both count against the budget.
  messages?: ModelMessage[];
  tools?: Record<string, CallTool>;
  // A shorter wait than the profile allows, for a caller that has others waiting for it.
  maxWaitSeconds?: number;
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
      // The tools that the model asked to be called, in the order it asked.
      toolCalls: ToolCall[];
      runId: string;
    }
  // The wait that the provider asked for, when it said, for a limit or a quota.
  // `refused`: the provider did nothing (or no request was made), so the same request may be
  // made again; otherwise the request may have been accepted and must not be repeated.
  | {
      ok: false;
      code: AiFailure;
      runId: string | null;
      refused: boolean;
      retryAfterSeconds?: number;
    };
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
const providerBody = z.object({
  error: z
    .object({
      type: z.string().nullish(),
      code: z.union([z.string(), z.number()]).nullish(),
      message: z.string().nullish(),
      details: z.array(z.unknown()).optional(),
    })
    .loose(),
});
const googleDetail = z.object({
  violations: z.array(z.object({ quotaId: z.string().nullish() }).loose()).optional(),
  retryDelay: z.string().optional(),
});
// The body of a failed call, parsed, when the provider sent one that looks like an error.
function bodyOf(error: APICallError) {
  let raw: unknown = error.data;
  if (raw === undefined && error.responseBody) {
    try {
      raw = JSON.parse(error.responseBody);
    } catch {
      return null;
    }
  }
  const parsed = providerBody.safeParse(raw);
  return parsed.success ? parsed.data.error : null;
}
const details = (body: ReturnType<typeof bodyOf>) =>
  (body?.details ?? []).flatMap((entry) => {
    const detail = googleDetail.safeParse(entry);
    return detail.success ? [detail.data] : [];
  });
// An account without credit is told by what the provider says, because the status
// is shared with other failures: OpenAI answers 429 with the type insufficient_quota
// (the status of a limit of requests too), Anthropic answers 400 with a text or the
// type billing_error, and Google answers 429 for a quota of the day with the same
// status as a limit per minute, which only the name of the quota tells apart.
function noCredit(error: APICallError): boolean {
  const body = bodyOf(error);
  if (!body) return false;
  return (
    body.type === "insufficient_quota" ||
    body.type === "billing_error" ||
    body.code === "insufficient_quota" ||
    body.code === "credit_balance_exhausted" ||
    /credit balance is too low/i.test(body.message ?? "") ||
    details(body).some((detail) =>
      detail.violations?.some((violation) => (violation.quotaId ?? "").includes("PerDay")),
    )
  );
}
// How long the provider asks to wait, in whole seconds, from the headers (a number of
// seconds, a date, or OpenAI's milliseconds) or from the retry information in the body
// of Google. A wait of more than a week is not taken at face value.
const longestWait = 7 * 24 * 3600;
function waitOf(error: APICallError): number | undefined {
  const headers = error.responseHeaders ?? {};
  const candidates: number[] = [];
  const ms = Number(headers["retry-after-ms"]);
  if (Number.isFinite(ms) && ms > 0) candidates.push(ms / 1000);
  const after = headers["retry-after"];
  if (after !== undefined) {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds > 0) candidates.push(seconds);
    else {
      const date = Date.parse(after);
      if (!Number.isNaN(date)) candidates.push((date - Date.now()) / 1000);
    }
  }
  for (const detail of details(bodyOf(error))) {
    const match = /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay ?? "");
    if (match?.[1]) candidates.push(Number(match[1]));
  }
  const seconds = candidates.find((value) => value > 0 && value <= longestWait);
  return seconds === undefined ? undefined : Math.ceil(seconds);
}
interface Failed {
  code: AiFailure;
  retryAfterSeconds?: number;
}
// What the status and the kind of a failed call tell the operator to do: nothing is
// told of the provider's own words, which may carry names and request details.
function failureOf(error: unknown): Failed {
  if (!APICallError.isInstance(error)) return { code: "ai_provider_error" };
  const wait = waitOf(error);
  const timed = (code: AiFailure): Failed => ({
    code,
    ...(wait === undefined ? {} : { retryAfterSeconds: wait }),
  });
  if (noCredit(error)) return timed("ai_quota_exhausted");
  if (error.statusCode === 404) return { code: "ai_model_unavailable" };
  if (error.statusCode === 429 || error.statusCode === 503 || error.statusCode === 529)
    return timed("ai_rate_limited");
  return { code: "ai_provider_error" };
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
      fallbackOf?: string;
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
        fallbackOf: extra.fallbackOf ?? null,
      })
      .returning({ id: aiRuns.id });
    return row?.id ?? "";
  };
  // A run that ends before a request was made, or that the provider refused, did nothing.
  const fail = async (
    code: AiFailure,
    extra = {},
    retryAfterSeconds?: number,
    refusedByProvider = true,
  ): Promise<AiOutcome> => ({
    ok: false,
    code,
    runId: await record(code, extra),
    refused: refusedByProvider,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
  const [profile] = await db()
    .select()
    .from(aiProfiles)
    .where(and(eq(aiProfiles.projectId, request.projectId), eq(aiProfiles.task, request.task)));
  if (!profile) return fail("ai_not_configured");
  const known = { profileVersion: profile.version, model: profile.model };
  if (!profile.enabled) return fail("ai_disabled", known);
  // The connection that a model is asked through: of this project, to a model provider, ready, with
  // a host that is still allowed and a secret that can be read; or none.
  const prepare = async (connectionId: string) => {
    const [connection] = await db()
      .select()
      .from(connections)
      .where(and(eq(connections.id, connectionId), eq(connections.projectId, request.projectId)));
    if (
      connection?.direction !== "ai" ||
      connection.status !== "ready" ||
      !isKind(connection.kind) ||
      !connection.secretCiphertext
    )
      return null;
    const endpoint =
      typeof connection.config.endpoint === "string" ? connection.config.endpoint : undefined;
    // An address of its own is checked again, so a name that has come to point somewhere
    // refused is not called.
    if (
      endpoint !== undefined &&
      connection.config.developmentOnly !== true &&
      (await checkHost(new URL(endpoint).hostname)) !== "allowed"
    )
      return null;
    const secret = aiSecret.safeParse(
      JSON.parse(unseal(connection.secretCiphertext, env().ENCRYPTION_KEY)),
    );
    if (!secret.success) return null;
    return {
      id: connection.id,
      kind: connection.kind,
      endpoint,
      workspaceId:
        typeof connection.config.workspaceId === "string"
          ? connection.config.workspaceId
          : undefined,
      apiKey: secret.data.apiKey,
    };
  };
  const target = await prepare(profile.connectionId);
  const withConnection = { ...known, connectionId: profile.connectionId };
  if (!target) return fail("ai_not_configured", withConnection);
  // The share of the budget this run holds while it runs: the input as estimated and
  // the longest answer the profile allows.
  const held =
    estimateTokens(request.system) +
    estimateTokens(request.prompt) +
    (request.messages ? estimateTokens(JSON.stringify(request.messages)) : 0) +
    (request.tools
      ? estimateTokens(
          JSON.stringify(
            Object.entries(request.tools).map(([name, { description, schema }]) => [
              name,
              description,
              z.toJSONSchema(schema),
            ]),
          ),
        )
      : 0) +
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
  // One request to one model: the answer, or how it failed and whether the provider did nothing.
  type Attempt =
    | { ok: true; answer: Awaited<ReturnType<typeof generate>> }
    | { ok: false; code: AiFailure; refused: boolean; retryAfterSeconds?: number };
  const ask = async (via: NonNullable<typeof target>, modelName: string): Promise<Attempt> => {
    try {
      return {
        ok: true,
        answer: await generate({
          kind: via.kind,
          endpoint: via.endpoint,
          workspaceId: via.workspaceId,
          apiKey: via.apiKey,
          model: modelName,
          system: request.system,
          prompt: request.prompt,
          files: request.files,
          messages: request.messages,
          tools: request.tools,
          maxOutputTokens: profile.maxOutputTokens,
          timeoutMs: Math.min(profile.timeoutSeconds, request.maxWaitSeconds ?? Infinity) * 1000,
        }),
      };
    } catch (error) {
      if (refused(error)) {
        const failed = failureOf(error);
        return {
          ok: false,
          code: failed.code,
          refused: true,
          ...(failed.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: failed.retryAfterSeconds }),
        };
      }
      if (timedOut(error)) return { ok: false, code: "ai_timeout", refused: false };
      const failed = failureOf(error);
      return {
        ok: false,
        code: failed.code,
        refused: false,
        ...(failed.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: failed.retryAfterSeconds }),
      };
    }
  };
  let attempt = await ask(target, profile.model);
  let used = {
    connectionId: profile.connectionId,
    model: profile.model,
    fallbackOf: null as string | null,
  };
  // The model of the profile did nothing (it is not there, or the provider refused the request):
  // the fallback that was approved with the profile is tried once. A limit, a quota, a timeout and
  // a request that may have been accepted are not retried anywhere.
  if (
    !attempt.ok &&
    attempt.refused &&
    fallbackCodes.includes(attempt.code) &&
    profile.fallbackConnectionId &&
    profile.fallbackModel
  ) {
    const second = await prepare(profile.fallbackConnectionId);
    if (second) {
      await record(attempt.code, withConnection);
      used = {
        connectionId: profile.fallbackConnectionId,
        model: profile.fallbackModel,
        fallbackOf: attempt.code,
      };
      attempt = await ask(second, profile.fallbackModel);
    }
  }
  const final = {
    profileVersion: profile.version,
    connectionId: used.connectionId,
    model: used.model,
    ...(used.fallbackOf ? { fallbackOf: used.fallbackOf } : {}),
  };
  if (!attempt.ok) {
    if (attempt.refused) await adjust(-held);
    return fail(attempt.code, final, attempt.retryAfterSeconds, attempt.refused);
  }
  const { answer } = attempt;
  const inputTokens = answer.usage.inputTokens ?? null;
  const outputTokens = answer.usage.outputTokens ?? null;
  // What the provider counted settles the share; when it did not say, the share that was held
  // stays charged.
  const settled = answer.usage.totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0);
  if (settled > 0) await adjust(settled - held);
  return {
    ok: true,
    text: answer.text,
    model: used.model,
    truncated: answer.finishReason === "length",
    usage: { inputTokens, outputTokens },
    toolCalls: answer.toolCalls ?? [],
    runId: await record("ok", { ...final, inputTokens, outputTokens }),
  };
}
