import { z } from "zod";
// What an operator sets for the replies that carry their name: the name that a customer reads and a signature under
// the text. An empty value removes it, and the name of the account is used then.
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();
export const profileInput = z
  .object({
    displayName: optional(100).describe("The name a customer reads on a reply"),
    signature: optional(2000).describe(
      "Markdown that follows the text of every reply of this operator",
    ),
  })
  .strict()
  .refine((value) => value.displayName !== undefined || value.signature !== undefined, {
    message: "Name at least one field",
  });
export const profileOut = z.object({
  name: z.string(),
  displayName: z.string().nullable(),
  signature: z.string().nullable(),
});
// The text of a reply with the signature of the person who wrote it.
export const signed = (markdown: string, signature: string | null | undefined) =>
  signature ? `${markdown.trimEnd()}\n\n${signature}` : markdown;
