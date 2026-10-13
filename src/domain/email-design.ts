import { z } from "zod";
import { locales } from "./locale";
import { baseLanguage, textKeys } from "./texts";
// The configurable part of a project's outgoing mail. Content comes from the
// message; a design only chooses how it is presented, never what is sent, and
// holds no raw HTML.
const fonts = {
  sans: "-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif",
  serif: "Georgia,Cambria,Times New Roman,serif",
  mono: "SFMono-Regular,Menlo,Consolas,monospace",
} as const;
export const fontStacks = fonts;
const text = (max: number) => z.string().trim().max(max);
// A logo is a public https address that recipients' mail programs load. It
// carries no credentials, and private attachments are never a source for it.
const logoUrl = z
  .url({ protocol: /^https$/ })
  .max(500)
  .refine((value) => {
    const url = new URL(value);
    return url.username === "" && url.password === "";
  });
export const emailDesignConfig = z
  .object({
    accent: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    fontFamily: z.enum(["sans", "serif", "mono"]).default("sans"),
    headerText: text(100).min(1).optional(),
    logoUrl: logoUrl.optional(),
    // Per language of the recipient; a missing language uses the project's
    // default language, and then nothing.
    footer: z.partialRecord(z.enum(locales), text(500)).default({}),
    signature: z.partialRecord(z.enum(locales), text(1000)).default({}),
  })
  .strict();
export type EmailDesignConfig = z.infer<typeof emailDesignConfig>;
export const defaultDesign: EmailDesignConfig = emailDesignConfig.parse({});
// The footer or signature for a recipient language, with the project's default
// language as the explicit fallback.
export function localized(
  texts: Partial<Record<string, string>>,
  language: string,
  fallback: string,
): string | null {
  const pick = (code: string) => {
    const value = texts[code.toLowerCase().split("-")[0] ?? ""]?.trim();
    if (!value) return null;
    return value;
  };
  return pick(language) ?? pick(fallback);
}
// The line above the footer that leads the recipient to the ticket page. The
// project may replace the text.
export function portalLinkText(language: string, own?: string): string {
  return own ?? textKeys.portalLink.defaults[baseLanguage(language)];
}
