// Junk classification without AI. It relies on the verdict of an upstream
// spam filter carried in the headers; an AI classifier follows with M4. A
// junk verdict keeps the mail out of the support inbox until a person
// restores it.
export interface JunkVerdict {
  junk: boolean;
  reason: string | null;
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "value" in value)
    return typeof value.value === "string" ? value.value : "";
  return "";
}
// Headers as parsed by mailparser: lower-case names.
export function classifyJunk(headers: ReadonlyMap<string, unknown>): JunkVerdict {
  if (/^\s*yes\b/i.test(text(headers.get("x-spam-flag"))))
    return { junk: true, reason: "spam_flag" };
  if (/^\s*yes\b/i.test(text(headers.get("x-spam-status"))))
    return { junk: true, reason: "spam_status" };
  if (/^\s*(yes|true|spam)\b/i.test(text(headers.get("x-spam"))))
    return { junk: true, reason: "spam_flag" };
  return { junk: false, reason: null };
}
