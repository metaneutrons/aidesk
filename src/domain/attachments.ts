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
// What an agent may read of a file. The bytes an agent receives are capped, and
// only types that are text are decoded: a file is written by the sender, so an
// agent gets it as text and as data, never as something it opens.
export const agentReadLimit = 256 * 1024;
const readableTypes = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/x-ndjson",
]);
const readableExtensions = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "log",
  "ics",
  "vcf",
]);
export type Unreadable = "type_not_readable" | "binary_content";
// A file is read as text when its declared type is text or a text format, or
// when the type says nothing (octet-stream) and the extension is a text one.
export function readableAsText(file: { filename: string; contentType: string }): boolean {
  const type = file.contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (type.startsWith("text/") || readableTypes.has(type) || type.endsWith("+json")) return true;
  if (type !== "application/octet-stream" && type !== "") return false;
  const dot = file.filename.lastIndexOf(".");
  return dot >= 0 && readableExtensions.has(file.filename.slice(dot + 1).toLowerCase());
}
// A NUL byte in the first bytes means the content is not text, whatever the
// declared type says.
export const looksBinary = (content: Buffer): boolean => content.subarray(0, 8192).includes(0);
// The part of a text an agent receives, and whether it was cut.
export function forAgent(content: Buffer): { text: string; truncated: boolean } {
  const truncated = content.length > agentReadLimit;
  return { text: content.subarray(0, agentReadLimit).toString("utf8"), truncated };
}
