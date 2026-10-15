import { z } from "zod";
// The tasks of the product that ask a model, and the profile of one: which
// connection and model run it, under which limits, and whether it may run. A
// profile that is on sends ticket content to the provider of its connection, so
// it is off by default (see src/server/ai-profiles.ts for who may switch it on).
export const aiTasks = ["reply.draft", "note.draft"] as const;
export type AiTask = (typeof aiTasks)[number];
export const isAiTask = (value: string): value is AiTask => aiTasks.some((task) => task === value);
export const aiDefaults = {
  timeoutSeconds: 60,
  maxOutputTokens: 2000,
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
