import { z } from "zod";
// What a ticket is worth and what it is about. The priority is one of four fixed levels; a project can give each
// level its own limits for the response clock. The category is one entry of a list that each project keeps (the
// configuration key `categories`, one name per line); a ticket has at most one. A ticket that had a category
// keeps it when the list loses the name, so that nothing is changed behind anybody's back.
export const priorities = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof priorities)[number];
export const defaultPriority: Priority = "normal";
export const priorityOf = (value: unknown): Priority =>
  priorities.find((entry) => entry === value) ?? defaultPriority;
export const maxCategories = 50;
export const maxCategoryLength = 40;
// The list of categories as written in the configuration: one name per line (commas do not separate, a name may
// contain one), empty lines left out. Null when a name is too long, a name is listed twice (the case does not
// matter), or there are too many.
export function parseCategories(text: string): string[] | null {
  const names = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const valid =
    names.length <= maxCategories &&
    names.every((name) => name.length <= maxCategoryLength) &&
    new Set(names.map((name) => name.toLowerCase())).size === names.length;
  return valid ? names : null;
}
export const categoriesOf = (settings: Record<string, unknown>): string[] =>
  typeof settings.categories === "string" ? (parseCategories(settings.categories) ?? []) : [];
// The name as the list writes it, for a name that matches an entry of the list in any case.
export const categoryIn = (list: readonly string[], name: string): string | null =>
  list.find((entry) => entry.toLowerCase() === name.trim().replace(/\s+/g, " ").toLowerCase()) ??
  null;
export const triageInput = z
  .object({
    priority: z.enum(priorities).optional(),
    // null takes the category off.
    category: z.string().trim().min(1).max(maxCategoryLength).nullable().optional(),
  })
  .strict()
  .refine((values) => values.priority !== undefined || values.category !== undefined, {
    message: "Name a priority or a category",
  });
export const triageOut = z.object({
  priority: z.enum(priorities),
  category: z.string().nullable(),
  changed: z.boolean(),
});
