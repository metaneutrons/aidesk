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
// How much the rules of a project trust the headers of the mail:
//   off       the rules never keep a mail out (the blocked senders of the project still do)
//   standard  the verdict of an upstream spam filter that the mail carries
//   strict    also bulk mail: a mailing list, or a mail marked as bulk or junk by its sender
export const junkSensitivities = ["off", "standard", "strict"] as const;
export type JunkSensitivity = (typeof junkSensitivities)[number];
export const defaultJunkSensitivity: JunkSensitivity = "standard";
export const junkSensitivityOf = (value: unknown): JunkSensitivity =>
  junkSensitivities.find((entry) => entry === value) ?? defaultJunkSensitivity;
function isBulk(headers: ReadonlyMap<string, unknown>): boolean {
  if (/^\s*(bulk|list|junk)\b/i.test(text(headers.get("precedence")))) return true;
  const list = headers.get("list");
  return (
    (typeof list === "object" &&
      list !== null &&
      ("id" in list || "post" in list || "unsubscribe" in list)) ||
    headers.has("list-id") ||
    headers.has("list-unsubscribe")
  );
}
// Headers as parsed by mailparser: lower-case names.
export function classifyJunk(
  headers: ReadonlyMap<string, unknown>,
  sensitivity: JunkSensitivity = defaultJunkSensitivity,
): JunkVerdict {
  if (sensitivity === "off") return { junk: false, reason: null };
  if (sensitivity === "strict" && isBulk(headers)) return { junk: true, reason: "bulk_mail" };
  if (/^\s*yes\b/i.test(text(headers.get("x-spam-flag"))))
    return { junk: true, reason: "spam_flag" };
  if (/^\s*yes\b/i.test(text(headers.get("x-spam-status"))))
    return { junk: true, reason: "spam_status" };
  if (/^\s*(yes|true|spam)\b/i.test(text(headers.get("x-spam"))))
    return { junk: true, reason: "spam_flag" };
  return { junk: false, reason: null };
}
