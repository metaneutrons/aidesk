// Rules for files received with a message. A refused file is not stored; its
// metadata and the reason stay visible so nothing disappears silently.
export const attachmentLimits = { maxCount: 25, maxBytes: 15 * 1024 * 1024 };
// Types that run code when opened on common desktop systems, including disk
// images that are used to carry them past filters.
const blockedExtensions = new Set([
  "app",
  "bat",
  "cmd",
  "com",
  "cpl",
  "dll",
  "exe",
  "hta",
  "img",
  "iso",
  "jar",
  "js",
  "jse",
  "lnk",
  "msc",
  "msi",
  "msp",
  "pif",
  "ps1",
  "psm1",
  "reg",
  "scf",
  "scr",
  "vbe",
  "vbs",
  "vhd",
  "vhdx",
  "wsf",
  "wsh",
]);
const blockedTypes = new Set([
  "application/hta",
  "application/java-archive",
  "application/x-dosexec",
  "application/x-msdos-program",
  "application/x-msdownload",
  "application/x-ms-installer",
]);
export type AttachmentRefusal =
  "attachment_type_blocked" | "attachment_too_large" | "attachment_count_exceeded";
// A display and download name without paths, control characters or leading
// dots, at most 180 characters with the extension kept.
export function safeFilename(name: string | undefined, index: number): string {
  let kept = "";
  for (const char of (name ?? "").normalize("NFC")) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f && char !== "/" && char !== "\\") kept += char;
  }
  const cleaned = kept.replace(/^[.\s]+|[.\s]+$/g, "");
  if (!cleaned) return `attachment-${String(index + 1)}`;
  if (cleaned.length <= 180) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 180 - extension.length) + extension;
}
export function attachmentRefusal(
  file: { filename: string; contentType: string; size: number },
  index: number,
): AttachmentRefusal | null {
  if (index >= attachmentLimits.maxCount) return "attachment_count_exceeded";
  const extension = file.filename.includes(".")
    ? (file.filename.split(".").pop() ?? "").toLowerCase()
    : "";
  if (blockedExtensions.has(extension) || blockedTypes.has(file.contentType.toLowerCase()))
    return "attachment_type_blocked";
  if (file.size > attachmentLimits.maxBytes) return "attachment_too_large";
  return null;
}
