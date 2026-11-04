import { z } from "zod";
// Tags are short labels that a team puts on tickets to find them again. One
// definition serves the server, which enforces it, and the desk, which shows
// the normalized form before saving.
export const maxTags = 10;
export const tagPattern = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,29}$/u;
export function normalizeTag(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, "-");
}
// The administration of the tags of a project (see `server/tag-admin.ts`): a tag is renamed or merged into another
// in all tickets of the project, given a colour for the chips, and removed from all of them after the number of
// tickets has been named.
// The style of a chip with a colour of the project: the colour as the background and black or white text on it.
export const tagStyle = (color: string | undefined, textOn: (background: string) => string) =>
  color === undefined ? undefined : { background: color, borderColor: color, color: textOn(color) };
const tag = z
  .string()
  .max(60)
  .transform(normalizeTag)
  .refine((value) => tagPattern.test(value), "A tag of letters, digits, hyphen and underscore");
export const tagColor = z.string().regex(/^#[0-9a-f]{6}$/i);
export const tagRename = z.object({ from: tag, to: tag }).strict();
export const tagMerge = z
  .object({
    from: z.array(tag).min(1).max(20),
    into: tag,
  })
  .strict()
  .refine(({ from, into }) => !from.includes(into) && new Set(from).size === from.length, {
    message: "The tags to merge are listed once and do not include the one they go into",
    path: ["from"],
  });
export const tagColorInput = z.object({ tag, color: tagColor.nullable() }).strict();
export const tagRemoval = z
  .object({
    tag,
    // The number of tickets that carry the tag, as it was shown; a different number is a conflict.
    expectedTickets: z.number().int().min(0),
  })
  .strict();
export const tagAdminOut = z.object({
  tag: z.string(),
  tickets: z.number(),
  color: z.string().nullable(),
});
export const tagChangeOut = z.object({ tickets: z.number() });
