import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Names resolve through this table; an unknown name resolves to a public address.
const dns = vi.hoisted(() => ({ table: new Map<string, string[]>() }));
vi.mock("node:dns/promises", () => ({
  lookup: (host: string) => {
    const found = dns.table.get(host) ?? ["93.184.216.34"];
    return Promise.resolve(
      found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
  },
}));
import { APICallError } from "ai";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { aiBudgets, aiProfiles, aiRuns, connections, projects } from "../src/server/db/schema";
import { runAiTask, type AiRequest } from "../src/server/ai-run";
import type { Answer, Call } from "../src/server/ai-provider";
import { estimateFileTokens, estimateTokens } from "../src/domain/ai";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
import { startFakeModels, type FakeModels, type Kind } from "./support/models";
const projectId = randomUUID();
const otherProject = randomUUID();
const apiKey = "sk-run-secret-key-value";
const system = "You draft replies for a support team.";
const prompt = "Customer wrote: where is my order 4711? Kim Example, kim@example.test";
const request = (overrides: Partial<AiRequest> = {}): AiRequest => ({
  projectId,
  task: "reply.draft",
  system,
  prompt,
  actor: { id: "operator-1", kind: "human" },
  ...overrides,
});
const held = (maxOutputTokens: number) =>
  estimateTokens(system) + estimateTokens(prompt) + maxOutputTokens;
let ready = "";
async function connection(
  project: string,
  options: {
    kind?: string;
    direction?: string;
    status?: string;
    config?: Record<string, unknown>;
    secret?: boolean;
  } = {},
) {
  const [row] = await db()
    .insert(connections)
    .values({
      projectId: project,
      kind: options.kind ?? "anthropic",
      direction: options.direction ?? "ai",
      name: "provider",
      status: options.status ?? "ready",
      config: options.config ?? {},
      secretCiphertext:
        options.secret === false ? null : seal(JSON.stringify({ apiKey }), env().ENCRYPTION_KEY),
    })
    .returning({ id: connections.id });
  return row?.id ?? "";
}
async function profile(
  overrides: Partial<typeof aiProfiles.$inferInsert> = {},
  project = projectId,
) {
  await db().delete(aiProfiles).where(eq(aiProfiles.projectId, project));
  await db()
    .insert(aiProfiles)
    .values({
      projectId: project,
      task: "reply.draft",
      connectionId: ready,
      model: "model-one",
      timeoutSeconds: 20,
      maxOutputTokens: 500,
      dailyTokenBudget: 100_000,
      enabled: true,
      ...overrides,
    });
}
const charged = async () =>
  (
    await db()
      .select()
      .from(aiBudgets)
      .where(and(eq(aiBudgets.projectId, projectId), eq(aiBudgets.task, "reply.draft")))
  ).reduce((sum, row) => sum + row.charged, 0);
const runs = () => db().select().from(aiRuns).where(eq(aiRuns.projectId, projectId));
const answer = (overrides: Partial<Answer> = {}): Answer => ({
  text: "Your order is on its way.",
  finishReason: "stop",
  usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
  ...overrides,
});
function fakeGenerate(result: Answer | Error | (() => Promise<Answer>)) {
  const calls: Call[] = [];
  const generate = (call: Call): Promise<Answer> => {
    calls.push(call);
    if (typeof result === "function") return result();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  return { calls, generate };
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "AI run", slug: `run-${projectId}` },
      { id: otherProject, name: "Other", slug: `run-${otherProject}` },
    ]);
  ready = await connection(projectId);
});
afterAll(async () => {
  await db().delete(projects).where(eq(projects.id, projectId));
  await db().delete(projects).where(eq(projects.id, otherProject));
  await sqlClient().end();
});
beforeEach(async () => {
  dns.table.clear();
  await db().delete(aiRuns).where(eq(aiRuns.projectId, projectId));
  await db().delete(aiBudgets).where(eq(aiBudgets.projectId, projectId));
  await db().delete(aiProfiles).where(eq(aiProfiles.projectId, projectId));
});
afterEach(() => {
  vi.restoreAllMocks();
});
describe("a run that cannot start", () => {
  it("says there is no profile, and records the run without calling anyone", async () => {
    const { calls, generate } = fakeGenerate(answer());
    expect(await runAiTask(request(), { generate })).toMatchObject({
      ok: false,
      code: "ai_not_configured",
    });
    expect(calls).toHaveLength(0);
    expect((await runs()).map((row) => row.outcome)).toEqual(["ai_not_configured"]);
  });
  it("says the profile is off, and does not call anyone", async () => {
    await profile({ enabled: false });
    const { calls, generate } = fakeGenerate(answer());
    expect(await runAiTask(request(), { generate })).toMatchObject({
      ok: false,
      code: "ai_disabled",
    });
    expect(calls).toHaveLength(0);
    expect(await charged()).toBe(0);
    expect((await runs())[0]).toMatchObject({
      outcome: "ai_disabled",
      profileVersion: 1,
      model: "model-one",
    });
  });
  it("needs a connection that is ready, of the project, to a model provider and with a key", async () => {
    const cases = [
      await connection(projectId, { status: "draft" }),
      await connection(projectId, { status: "degraded" }),
      await connection(projectId, { status: "disabled" }),
      await connection(projectId, { direction: "outbound", kind: "smtp" }),
      await connection(projectId, { secret: false }),
      await connection(projectId, { kind: "mistral" }),
      await connection(otherProject),
    ];
    for (const connectionId of cases) {
      await profile({ connectionId });
      const { calls, generate } = fakeGenerate(answer());
      expect(await runAiTask(request(), { generate }), connectionId).toMatchObject({
        ok: false,
        code: "ai_not_configured",
      });
      expect(calls).toHaveLength(0);
    }
    expect(await charged()).toBe(0);
  });
  it("checks the address of a connection again, unless it is a development address", async () => {
    dns.table.set("gateway.example.test", ["93.184.216.34"]);
    const gateway = await connection(projectId, {
      config: { endpoint: "https://gateway.example.test" },
    });
    await profile({ connectionId: gateway });
    const ok = fakeGenerate(answer());
    expect(await runAiTask(request(), { generate: ok.generate })).toMatchObject({ ok: true });
    expect(ok.calls[0]?.endpoint).toBe("https://gateway.example.test");
    // The name has come to point at the machine.
    dns.table.set("gateway.example.test", ["127.0.0.1"]);
    const refused = fakeGenerate(answer());
    expect(await runAiTask(request(), { generate: refused.generate })).toMatchObject({
      ok: false,
      code: "ai_not_configured",
    });
    expect(refused.calls).toHaveLength(0);
    const local = await connection(projectId, {
      config: { endpoint: "http://127.0.0.1:9", developmentOnly: true },
    });
    await profile({ connectionId: local });
    expect(await runAiTask(request(), { generate: ok.generate })).toMatchObject({ ok: true });
  });
  it("cannot use the profile or the connection of another project", async () => {
    const foreign = await connection(otherProject);
    await profile({ connectionId: foreign }, otherProject);
    const { calls, generate } = fakeGenerate(answer());
    // The profile of the other project is not found for this one.
    expect(await runAiTask(request(), { generate })).toMatchObject({
      ok: false,
      code: "ai_not_configured",
    });
    // A profile of this project that names the connection of the other one is refused.
    await profile({ connectionId: foreign });
    expect(await runAiTask(request(), { generate })).toMatchObject({
      ok: false,
      code: "ai_not_configured",
    });
    expect(calls).toHaveLength(0);
    await db().delete(aiProfiles).where(eq(aiProfiles.projectId, otherProject));
  });
});
describe("a run that goes through", () => {
  it("gives the text, the usage and a record, and calls the provider once with what the profile says", async () => {
    await profile();
    const { calls, generate } = fakeGenerate(answer());
    const outcome = await runAiTask(request(), { generate });
    expect(outcome).toMatchObject({
      ok: true,
      text: "Your order is on its way.",
      truncated: false,
      usage: { inputTokens: 40, outputTokens: 12 },
    });
    expect(calls).toEqual([
      {
        kind: "anthropic",
        endpoint: undefined,
        apiKey,
        model: "model-one",
        system,
        prompt,
        maxOutputTokens: 500,
        timeoutMs: 20_000,
      },
    ]);
    const [row] = await runs();
    expect(row).toMatchObject({
      outcome: "ok",
      task: "reply.draft",
      profileVersion: 1,
      connectionId: ready,
      model: "model-one",
      inputTokens: 40,
      outputTokens: 12,
      actorKind: "human",
      actorId: "operator-1",
    });
    // The record holds what happened and nothing of what it was about.
    const stored = JSON.stringify(row);
    for (const secretText of [prompt, "order 4711", "kim@example.test", "on its way", apiKey])
      expect(stored).not.toContain(secretText);
    expect(outcome.ok && outcome.runId).toBe(row?.id);
    // What the provider counted is charged, not what was held.
    expect(await charged()).toBe(52);
  });
  it("says that the answer was cut at the limit of the profile", async () => {
    await profile();
    const { generate } = fakeGenerate(answer({ finishReason: "length" }));
    expect(await runAiTask(request(), { generate })).toMatchObject({ ok: true, truncated: true });
  });
  it("keeps the share it held when the provider does not say what it used", async () => {
    await profile();
    const { generate } = fakeGenerate(answer({ usage: {} }));
    expect(await runAiTask(request(), { generate })).toMatchObject({
      ok: true,
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(await charged()).toBe(held(500));
  });
});
describe("the daily budget", () => {
  it("is held before the call, settled after it and refuses a run that does not fit, without a call", async () => {
    await profile({ dailyTokenBudget: 200, maxOutputTokens: 50 });
    const share = held(50);
    expect(share).toBeLessThan(200);
    const first = fakeGenerate(answer({ usage: { totalTokens: 120 } }));
    expect(await runAiTask(request(), { generate: first.generate })).toMatchObject({ ok: true });
    expect(await charged()).toBe(120);
    // 120 used; 80 are left, and a run holds more than that.
    const second = fakeGenerate(answer());
    expect(await runAiTask(request(), { generate: second.generate })).toMatchObject({
      ok: false,
      code: "ai_budget_exceeded",
    });
    expect(second.calls).toHaveLength(0);
    expect(await charged()).toBe(120);
    expect((await runs()).map((row) => row.outcome).sort()).toEqual(["ai_budget_exceeded", "ok"]);
  });
  it("refuses a run that is larger than the whole budget and writes nothing for it", async () => {
    await profile({ dailyTokenBudget: 100, maxOutputTokens: 500 });
    const { calls, generate } = fakeGenerate(answer());
    expect(await runAiTask(request(), { generate })).toMatchObject({
      ok: false,
      code: "ai_budget_exceeded",
    });
    expect(calls).toHaveLength(0);
    expect(await charged()).toBe(0);
  });
  it("starts again on the next day, and the two days do not share a count", async () => {
    // 500 are used on a day; what is left is less than a run holds.
    await profile({ dailyTokenBudget: 500 + held(50) - 1, maxOutputTokens: 50 });
    const { generate } = fakeGenerate(answer({ usage: { totalTokens: 500 } }));
    const monday = () => new Date("2026-10-12T10:00:00Z");
    const tuesday = () => new Date("2026-10-13T00:00:01Z");
    expect(await runAiTask(request(), { generate, now: monday })).toMatchObject({ ok: true });
    expect(await runAiTask(request(), { generate, now: monday })).toMatchObject({
      code: "ai_budget_exceeded",
    });
    expect(await runAiTask(request(), { generate, now: tuesday })).toMatchObject({ ok: true });
    const days = await db().select().from(aiBudgets).where(eq(aiBudgets.projectId, projectId));
    expect(days.map((row) => [row.day, row.charged]).sort()).toEqual([
      ["2026-10-12", 500],
      ["2026-10-13", 500],
    ]);
  });
  it("lets concurrent runs spend no more than the budget", async () => {
    const share = held(300);
    await profile({ dailyTokenBudget: share * 2 + 10, maxOutputTokens: 300 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, generate } = fakeGenerate(async () => {
      await gate;
      return answer({ usage: { totalTokens: share } });
    });
    const started = Array.from({ length: 6 }, () => runAiTask(request(), { generate }));
    // Those that were refused are done at once; those that hold a share wait on the gate.
    await vi.waitFor(async () => {
      expect((await runs()).filter((row) => row.outcome === "ai_budget_exceeded")).toHaveLength(4);
    });
    release();
    const outcomes = await Promise.all(started);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(await charged()).toBe(share * 2);
  });
  it("counts each task on its own", async () => {
    await profile({ dailyTokenBudget: held(500) + 10 });
    await db()
      .insert(aiProfiles)
      .values({
        projectId,
        task: "note.draft",
        connectionId: ready,
        model: "model-one",
        timeoutSeconds: 20,
        maxOutputTokens: 500,
        dailyTokenBudget: held(500) + 10,
        enabled: true,
      });
    const { generate } = fakeGenerate(answer({ usage: { totalTokens: held(500) } }));
    expect(await runAiTask(request(), { generate })).toMatchObject({ ok: true });
    expect(await runAiTask(request(), { generate })).toMatchObject({ code: "ai_budget_exceeded" });
    expect(await runAiTask(request({ task: "note.draft" }), { generate })).toMatchObject({
      ok: true,
    });
  });
});
describe("a call whose outcome is not known, and one that was refused", () => {
  const failure = (statusCode?: number, data?: unknown, responseHeaders?: Record<string, string>) =>
    new APICallError({
      message: "failed",
      url: "https://provider.example.test",
      requestBodyValues: {},
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(data === undefined ? {} : { data }),
      ...(responseHeaders === undefined ? {} : { responseHeaders }),
    });
  it("ends at the timeout, is not repeated and keeps the share charged", async () => {
    await profile({ timeoutSeconds: 1 });
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const { calls, generate } = fakeGenerate(timeout);
    expect(await runAiTask(request(), { generate })).toMatchObject({
      ok: false,
      code: "ai_timeout",
    });
    expect(calls).toHaveLength(1);
    expect(await charged()).toBe(held(500));
    expect((await runs())[0]).toMatchObject({ outcome: "ai_timeout", inputTokens: null });
  });
  it("is a failure of the provider when it fails or the network does, once, with the share kept, and tries no other provider", async () => {
    const other = await connection(projectId, { kind: "openai" });
    await profile();
    for (const [error, code] of [
      [failure(500), "ai_provider_error"],
      [failure(503), "ai_rate_limited"],
      [failure(408), "ai_provider_error"],
      [failure(), "ai_provider_error"],
      [new Error("socket hang up"), "ai_provider_error"],
    ] as const) {
      const { calls, generate } = fakeGenerate(error);
      expect(await runAiTask(request(), { generate })).toMatchObject({ ok: false, code });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.kind).toBe("anthropic");
      expect(calls.some((call) => call.kind === "openai")).toBe(false);
    }
    expect(await charged()).toBe(held(500) * 5);
    expect(other).not.toBe("");
  });
  it("tells an account without credit from a limit, by what the provider says", async () => {
    await profile();
    const outOfCredit = {
      type: "insufficient_quota",
      code: "credit_balance_exhausted",
      message: "x",
    };
    for (const [error, code] of [
      // OpenAI: the status of a limit of requests, told apart by the type.
      [failure(429, { error: outOfCredit }), "ai_quota_exhausted"],
      [
        failure(429, { error: { type: "requests", code: "rate_limit_exceeded" } }),
        "ai_rate_limited",
      ],
      // Anthropic: a 400 with a text.
      [
        failure(400, {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Your credit balance is too low to access the Anthropic API.",
          },
        }),
        "ai_quota_exhausted",
      ],
      [
        failure(400, {
          error: { type: "invalid_request_error", message: "max_tokens is too large" },
        }),
        "ai_provider_error",
      ],
      // Neither a body that does not say so nor a body that is not an error object.
      [failure(429, { error: { code: "credit_balance_exhausted" } }), "ai_quota_exhausted"],
      [failure(429, { error: { code: "insufficient_quota" } }), "ai_quota_exhausted"],
      // Anthropic names a billing failure by its type.
      [failure(402, { type: "error", error: { type: "billing_error" } }), "ai_quota_exhausted"],
      // Google: a quota of the day is an account that cannot go on today, a quota per
      // minute is a limit; both come as 429.
      [
        failure(429, {
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            details: [
              { "@type": "type.googleapis.com/google.rpc.Help", links: [] },
              {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }],
              },
            ],
          },
        }),
        "ai_quota_exhausted",
      ],
      [
        failure(429, {
          error: {
            code: 429,
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }],
              },
            ],
          },
        }),
        "ai_rate_limited",
      ],
      [failure(429, { error: { message: "slow down" } }), "ai_rate_limited"],
      [failure(429, "insufficient_quota"), "ai_rate_limited"],
    ] as const) {
      const { generate } = fakeGenerate(error);
      expect(await runAiTask(request(), { generate })).toMatchObject({ ok: false, code });
    }
    // The share is given back for every one of them, as for any refusal.
    expect(await charged()).toBe(0);
  });
  it("passes on how long the provider asks to wait, from its headers or its body, and drops what is not credible", async () => {
    await profile();
    const google = (quotaId: string, retryDelay?: string) => ({
      error: {
        code: 429,
        details: [
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] },
          ...(retryDelay
            ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }]
            : []),
        ],
      },
    });
    const inSeconds = new Date(Date.now() + 90_000).toUTCString();
    for (const [error, code, wait] of [
      [failure(429, undefined, { "retry-after": "120" }), "ai_rate_limited", 120],
      // OpenAI also says it in milliseconds, which is more exact.
      [
        failure(429, undefined, { "retry-after-ms": "1728000", "retry-after": "1" }),
        "ai_rate_limited",
        1728,
      ],
      [failure(503, undefined, { "retry-after": inSeconds }), "ai_rate_limited", 90],
      [
        failure(429, google("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "19684s")),
        "ai_quota_exhausted",
        19_684,
      ],
      [
        failure(429, google("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "2.5s")),
        "ai_rate_limited",
        3,
      ],
      // No time, a time that has passed, nonsense, and more than a week.
      [failure(429), "ai_rate_limited", undefined],
      [failure(429, undefined, { "retry-after": "0" }), "ai_rate_limited", undefined],
      [failure(429, undefined, { "retry-after": "soon" }), "ai_rate_limited", undefined],
      [failure(429, undefined, { "retry-after": "99999999" }), "ai_rate_limited", undefined],
      [
        failure(429, google("GenerateRequestsPerMinutePerProjectPerModel", "abc")),
        "ai_rate_limited",
        undefined,
      ],
      // A model that the provider does not have does not wait.
      [failure(404, undefined, { "retry-after": "60" }), "ai_model_unavailable", undefined],
    ] as const) {
      const { generate } = fakeGenerate(error);
      const outcome = await runAiTask(request(), { generate });
      expect(outcome).toMatchObject({ ok: false, code });
      const seconds = outcome.ok ? undefined : outcome.retryAfterSeconds;
      if (wait === undefined) expect(seconds).toBeUndefined();
      else expect(Math.abs((seconds ?? 0) - wait)).toBeLessThanOrEqual(wait === 90 ? 3 : 0);
    }
  });
  it("gives the share back when the provider refused the request before doing anything", async () => {
    await profile();
    for (const [status, code] of [
      [400, "ai_provider_error"],
      [401, "ai_provider_error"],
      [403, "ai_provider_error"],
      [404, "ai_model_unavailable"],
      [429, "ai_rate_limited"],
    ] as const) {
      const { generate } = fakeGenerate(failure(status));
      expect(await runAiTask(request(), { generate }), String(status)).toMatchObject({
        ok: false,
        code,
      });
    }
    expect(await charged()).toBe(0);
  });
});
const kinds: {
  kind: Kind;
  path: string;
  key: (headers: Record<string, unknown>) => unknown;
  limit: (body: Record<string, unknown>) => unknown;
}[] = [
  {
    kind: "anthropic",
    path: "/v1/messages",
    key: (headers) => headers["x-api-key"],
    limit: (body) => body.max_tokens,
  },
  {
    kind: "openai",
    path: "/v1/chat/completions",
    key: (headers) =>
      typeof headers.authorization === "string" ? headers.authorization.replace("Bearer ", "") : "",
    limit: (body) => body.max_completion_tokens ?? body.max_tokens,
  },
  {
    kind: "google",
    path: "/v1beta/models/model-one:generateContent",
    key: (headers) => headers["x-goog-api-key"],
    limit: (body) =>
      (body.generationConfig as { maxOutputTokens?: number } | undefined)?.maxOutputTokens,
  },
];
describe("a run with files", () => {
  const image = { mediaType: "image/png", data: new Uint8Array(6000).fill(7) };
  const scan = { mediaType: "application/pdf", data: new Uint8Array(100_000).fill(9) };
  it("hands the files to the provider and holds their share of the budget", async () => {
    await profile({ task: "image.read", dailyTokenBudget: 100_000 });
    const { calls, generate } = fakeGenerate(answer({ usage: {} }));
    const outcome = await runAiTask(request({ task: "image.read", files: [image, scan] }), {
      generate,
    });
    expect(outcome).toMatchObject({ ok: true, model: "model-one" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.files).toEqual([image, scan]);
    // No usage from the provider, so what was held stays charged: the input, both
    // files (2000 for the image, 10000 for the scan) and the longest answer.
    expect(estimateFileTokens(image.mediaType, image.data.length)).toBe(2000);
    expect(estimateFileTokens(scan.mediaType, scan.data.length)).toBe(10_000);
    const [row] = await db()
      .select()
      .from(aiBudgets)
      .where(and(eq(aiBudgets.projectId, projectId), eq(aiBudgets.task, "image.read")));
    expect(row?.charged).toBe(held(500) + 12_000);
  });
  it("costs little for an image however large and is capped for a PDF", () => {
    expect(estimateFileTokens("image/jpeg", 5 * 1024 * 1024)).toBe(8000);
    expect(estimateFileTokens("application/pdf", 10 * 1024 * 1024)).toBe(200_000);
  });
  it("refuses a run whose files do not fit the budget, without a call", async () => {
    await profile({ task: "image.read", dailyTokenBudget: held(500) + 11_999 });
    const { calls, generate } = fakeGenerate(answer());
    expect(
      await runAiTask(request({ task: "image.read", files: [image, scan] }), { generate }),
    ).toMatchObject({ ok: false, code: "ai_budget_exceeded" });
    expect(calls).toHaveLength(0);
  });
  it("sends no files when there are none", async () => {
    await profile();
    const { calls, generate } = fakeGenerate(answer());
    await runAiTask(request(), { generate });
    expect(calls[0]?.files).toBeUndefined();
  });
});
describe("the real call to each provider, against a fake one", () => {
  for (const { kind, path, key, limit } of kinds) {
    describe(kind, () => {
      let models: FakeModels;
      let id = "";
      beforeAll(async () => {
        models = await startFakeModels(kind);
      });
      afterAll(async () => {
        await models.close();
      });
      beforeEach(async () => {
        models.requests.length = 0;
        models.behaviour = {};
        vi.stubEnv("NODE_ENV", "development");
        vi.stubEnv("DEV_BOOTSTRAP", "true");
        id = await connection(projectId, {
          kind,
          config: { endpoint: models.url, developmentOnly: true },
        });
        await profile({ connectionId: id, timeoutSeconds: 2, maxOutputTokens: 321 });
      });
      afterEach(() => {
        vi.unstubAllEnvs();
      });
      it("sends the prompt to the path of the provider with the key in a header, and reads the text and the usage", async () => {
        models.behaviour = { text: "From the fake provider" };
        const outcome = await runAiTask(request());
        expect(outcome).toMatchObject({ ok: true, text: "From the fake provider" });
        expect(outcome.ok && outcome.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
        expect(models.requests).toHaveLength(1);
        const [sent] = models.requests;
        expect(sent?.url.split("?")[0]).toBe(path);
        expect(sent?.url).not.toContain(apiKey);
        expect(key(sent?.headers ?? {})).toBe(apiKey);
        expect(limit(sent?.body ?? {})).toBe(321);
        expect(JSON.stringify(sent?.body)).toContain("where is my order 4711");
        expect(await charged()).toBe(18);
      });
      it("sends an image and a PDF as bytes in the form of the provider, with one request", async () => {
        await profile({
          task: "image.read",
          connectionId: id,
          timeoutSeconds: 2,
          maxOutputTokens: 321,
        });
        const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 250, 251]);
        const doc = Uint8Array.from(Buffer.from("%PDF-1.7 a scan \u00e4\u00f6", "latin1"));
        // The SDK reports a deprecated way of passing a file; none may be used.
        const warnings: unknown[] = [];
        Reflect.set(globalThis, "AI_SDK_LOG_WARNINGS", (warning: unknown) =>
          warnings.push(warning),
        );
        const outcome = await runAiTask(
          request({
            task: "image.read",
            files: [
              { mediaType: "image/png", data: png },
              { mediaType: "application/pdf", data: doc },
            ],
          }),
        ).finally(() => Reflect.deleteProperty(globalThis, "AI_SDK_LOG_WARNINGS"));
        expect(outcome).toMatchObject({ ok: true });
        expect(warnings).toEqual([]);
        expect(models.requests).toHaveLength(1);
        const body = JSON.stringify(models.requests[0]?.body);
        expect(body).toContain(Buffer.from(png).toString("base64"));
        expect(body).toContain(Buffer.from(doc).toString("base64"));
        expect(body).toContain("image/png");
        expect(body).toContain("application/pdf");
        expect(body).toContain("where is my order 4711");
      });
      it("sends the workspace of the connection in a header for Anthropic, and for no other kind", async () => {
        const workspaceId = "wrkspc_01VbRKx84B4vA6YW45KH2BkQ";
        const named = await connection(projectId, {
          kind,
          config: { endpoint: models.url, developmentOnly: true, workspaceId },
        });
        await profile({ connectionId: named, timeoutSeconds: 2, maxOutputTokens: 321 });
        models.requests.length = 0;
        expect(await runAiTask(request())).toMatchObject({ ok: true });
        expect(models.requests[0]?.headers["anthropic-workspace-id"]).toBe(
          kind === "anthropic" ? workspaceId : undefined,
        );
      });
      it("ends at the timeout and is not repeated", async () => {
        models.behaviour = { delay: 3000 };
        expect(await runAiTask(request())).toMatchObject({ ok: false, code: "ai_timeout" });
        expect(models.requests).toHaveLength(1);
        expect(await charged()).toBe(held(321));
      }, 15_000);
      it("tells a model the provider does not have and a limit of the provider from any other failure", async () => {
        // A refusal before anything was done gives the share back: 404 and 429.
        models.behaviour = { status: 404 };
        expect(await runAiTask(request())).toMatchObject({
          ok: false,
          code: "ai_model_unavailable",
        });
        expect(await charged()).toBe(0);
        models.behaviour = { status: 429 };
        expect(await runAiTask(request())).toMatchObject({ ok: false, code: "ai_rate_limited" });
        expect(await charged()).toBe(0);
        // A busy provider (503, 529) may have started: the share stays, and it is not repeated.
        models.requests.length = 0;
        models.behaviour = { status: 503 };
        expect(await runAiTask(request())).toMatchObject({ ok: false, code: "ai_rate_limited" });
        expect(await charged()).toBe(held(321));
        models.behaviour = { status: 529 };
        expect(await runAiTask(request())).toMatchObject({ ok: false, code: "ai_rate_limited" });
        expect(models.requests).toHaveLength(2);
        // A key that is refused and any other status stay a failure of the provider.
        for (const status of [400, 401, 403, 500]) {
          models.behaviour = { status };
          expect(await runAiTask(request())).toMatchObject({
            ok: false,
            code: "ai_provider_error",
          });
        }
        const codes = (await runs()).map((row) => row.outcome);
        expect(codes.filter((code) => code === "ai_model_unavailable")).toHaveLength(1);
        expect(codes.filter((code) => code === "ai_rate_limited")).toHaveLength(3);
      }, 15_000);
      it("tells the lack of credit from the body of a real answer", async () => {
        models.behaviour = {
          status: kind === "anthropic" ? 400 : 429,
          error:
            kind === "anthropic"
              ? { type: "invalid_request_error", message: "Your credit balance is too low" }
              : { type: "insufficient_quota", code: "credit_balance_exhausted", message: "none" },
        };
        expect(await runAiTask(request())).toMatchObject({ ok: false, code: "ai_quota_exhausted" });
        expect(await charged()).toBe(0);
        models.behaviour = { status: 429 };
        expect(await runAiTask(request())).toMatchObject({ ok: false, code: "ai_rate_limited" });
      });
      it("passes on the wait that the headers of a real answer name", async () => {
        models.behaviour = { status: 429, headers: { "retry-after": "75" } };
        expect(await runAiTask(request())).toMatchObject({
          ok: false,
          code: "ai_rate_limited",
          retryAfterSeconds: 75,
        });
      });
      it("keeps the share after a failure of the provider and gives it back after a refusal, with one request each", async () => {
        models.behaviour = { status: 500 };
        expect(await runAiTask(request())).toMatchObject({ ok: false, code: "ai_provider_error" });
        expect(models.requests).toHaveLength(1);
        expect(await charged()).toBe(held(321));
        models.requests.length = 0;
        models.behaviour = { status: 401 };
        expect(await runAiTask(request())).toMatchObject({ ok: false, code: "ai_provider_error" });
        expect(models.requests).toHaveLength(1);
        expect(await charged()).toBe(held(321));
      }, 15_000);
    });
  }
});
