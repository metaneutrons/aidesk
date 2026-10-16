import { z } from "zod";
// The tasks of the product that ask a model, and the profile of one: which
// connection and model run it, under which limits, and whether it may run. A
// profile that is on sends ticket content to the provider of its connection, so
// it is off by default (see src/server/ai-profiles.ts for who may switch it on).
export const aiTasks = [
  "reply.draft",
  "note.draft",
  "image.read",
  "agent.respond",
  "intake.extract",
  "intake.junk",
  "message.translate",
  "template.translate",
] as const;
export type AiTask = (typeof aiTasks)[number];
export const isAiTask = (value: string): value is AiTask => aiTasks.some((task) => task === value);
export const aiDefaults = {
  timeoutSeconds: 60,
  maxOutputTokens: 4000,
  dailyTokenBudget: 200_000,
} as const;
// A model name as the providers write them: letters, digits and a few signs.
const model = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "A model name has letters, digits and . _ : / -");
// A change names the version it read; a profile that does not exist yet has
// version 0. Everything but the version has a default, and a profile is off unless
// the request says otherwise.
export const aiProfileWrite = z
  .object({
    expectedVersion: z.number().int().min(0),
    connectionId: z.uuid(),
    model,
    timeoutSeconds: z.number().int().min(1).max(300).default(aiDefaults.timeoutSeconds),
    maxOutputTokens: z.number().int().min(1).max(16_000).default(aiDefaults.maxOutputTokens),
    dailyTokenBudget: z.number().int().min(1).max(100_000_000).default(aiDefaults.dailyTokenBudget),
    enabled: z.boolean().default(false),
    idempotencyKey: z.uuid().optional(),
  })
  .strict();
export type AiProfileWrite = z.infer<typeof aiProfileWrite>;
// How a run of a task can end without an answer. The codes name no provider, no
// host and no key.
export const aiFailures = [
  // No profile, or the connection of the profile is not ready or its host is not allowed.
  "ai_not_configured",
  "ai_disabled",
  "ai_budget_exceeded",
  "ai_timeout",
  // The provider does not know the model of the profile (status 404), for example
  // because it was retired: the profile has to name another one.
  "ai_model_unavailable",
  // The account at the provider has no credit or quota left (OpenAI: 429 with the type
  // insufficient_quota, Anthropic: 400 "credit balance is too low"): it has to be
  // topped up there, waiting does not help.
  "ai_quota_exhausted",
  // The provider limits the requests or is overloaded (status 429, 503, 529): a
  // later call may work.
  "ai_rate_limited",
  // Any other refusal or failure of the provider.
  "ai_provider_error",
] as const;
export type AiFailure = (typeof aiFailures)[number];
// A count of tokens that is high rather than exact: one for every three bytes of
// the text, which is more than Latin text needs and about what other scripts need.
// It decides how much of the budget a run holds while it is running.
export const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text) / 3);
// What a file held in the request costs: an image is scaled down by the providers
// and costs little however large it is, a PDF costs for every page it has. Both are
// estimated high and capped; the provider's count settles the run.
export const estimateFileTokens = (mediaType: string, bytes: number): number =>
  mediaType === "application/pdf"
    ? Math.min(Math.ceil(bytes / 10), 200_000)
    : Math.min(Math.ceil(bytes / 3), 8_000);
