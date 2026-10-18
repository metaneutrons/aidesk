import { z } from "zod";
export const logoMaxBytes = 256 * 1024;
// How a project brands its customer page. Every field can be left out (unchanged) or be null (removed). The colour
// is the background of the buttons; the text on it is black or white, whichever reads better, so any colour works.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();
export const brandingInput = z
  .object({
    displayName: optionalText(80).describe("The name that the page shows above the conversation"),
    headerText: optionalText(300).describe("A line of plain text under the name"),
    accentColor: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, "A colour like #5167ed")
      .transform((value) => value.toLowerCase())
      .nullable()
      .optional(),
    language: z
      .enum(["en", "de"])
      .nullable()
      .optional()
      .describe("Fixes the language of the page; without it the browser's wins"),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "Name at least one field",
  });
export const logoInput = z
  .object({
    data: z
      .string()
      .min(1)
      .max(Math.ceil((logoMaxBytes * 4) / 3) + 8)
      .describe("The image as base64 (PNG, JPEG or WebP)"),
  })
  .strict();
export const brandingOut = z.object({
  displayName: z.string().nullable(),
  headerText: z.string().nullable(),
  accentColor: z.string().nullable(),
  language: z.enum(["en", "de"]).nullable(),
  hasLogo: z.boolean(),
  updatedAt: z.string().nullable(),
});
// The image types that are accepted, by their first bytes. SVG is left out: it can carry script.
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  const startsWith = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}
// Black or white text for a background, by the contrast ratio of WCAG 2.
export function textOn(background: string): "#000000" | "#ffffff" {
  const channel = (offset: number) => {
    const value = parseInt(background.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}
