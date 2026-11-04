import { z } from "zod";
// Canned replies: texts that a project keeps for answers that come up again and again. A reply has a name, a
// language (en or de) and a body in Markdown that can hold placeholders. Placeholders are filled in for a ticket and
// for the person or agent who uses the reply. A ticket gets the replies of its language first.
export const cannedLanguages = ["en", "de"] as const;
export type CannedLanguage = (typeof cannedLanguages)[number];
export const maxCannedReplies = 100;
export const maxCannedBody = 4000;
export const cannedPlaceholders = ["customer_name", "ticket_number", "operator_name"] as const;
export type CannedPlaceholder = (typeof cannedPlaceholders)[number];
const pattern = /\{\{\s*([^{}]*?)\s*\}\}/g;
// The names between double braces, in the order of their first use.
export const placeholdersIn = (body: string): string[] => [
  ...new Set([...body.matchAll(pattern)].map((found) => found[1] ?? "")),
];
// What is wrong with a body: a placeholder that does not exist, or braces that are not closed.
export function cannedProblems(body: string): string[] {
  const problems = placeholdersIn(body)
    .filter((name) => !(cannedPlaceholders as readonly string[]).includes(name))
    .map((name) => `Unknown placeholder {{${name}}}`);
  if (/\{\{|\}\}/.exec(body.replace(pattern, ""))) problems.push("Braces that are not closed");
  return problems;
}
export interface CannedValues {
  customer_name: string;
  ticket_number: string;
  operator_name: string;
}
// The body with its placeholders filled in. A value that is empty leaves nothing in its place.
export const renderCanned = (body: string, values: CannedValues): string =>
  body.replace(pattern, (_, name: string) =>
    (cannedPlaceholders as readonly string[]).includes(name)
      ? values[name as CannedPlaceholder]
      : `{{${name}}}`,
  );
export const cannedInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    language: z.enum(cannedLanguages),
    body: z.string().trim().min(1).max(maxCannedBody),
    // The version that was read, to change or remove a reply; left out to add one.
    expectedVersion: z.number().int().min(1).optional(),
    idempotencyKey: z.uuid().optional(),
  })
  .strict()
  .refine((value) => cannedProblems(value.body).length === 0, {
    message: "Placeholders are {{customer_name}}, {{ticket_number}} and {{operator_name}}",
    path: ["body"],
  });
export const cannedRemoval = z
  .object({ expectedVersion: z.number().int().min(1), idempotencyKey: z.uuid().optional() })
  .strict();
export const cannedOut = z.object({
  id: z.uuid(),
  name: z.string(),
  language: z.enum(cannedLanguages),
  body: z.string(),
  version: z.number(),
  updatedAt: z.string(),
});
// A reply for a ticket: the text with the placeholders filled in.
export const cannedForTicketOut = z.object({
  id: z.uuid(),
  name: z.string(),
  language: z.enum(cannedLanguages),
  text: z.string(),
});
