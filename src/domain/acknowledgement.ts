import { baseLanguage, fillText, textKeys } from "./texts";
// Automatic acknowledgements of new tickets. They must never answer other
// automatic mail, which would start a loop between two systems, and never
// reach mailing lists or bounce addresses.
export const acknowledgementInterval = 60 * 60 * 1000;
const automaticLocalParts =
  /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|notifications?)([+._-].*)?$/i;
type HeaderValue = unknown;
function text(value: HeaderValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    if ("value" in value && typeof value.value === "string") return value.value;
    if ("text" in value && typeof value.text === "string") return value.text;
  }
  return "";
}
// Headers as parsed by mailparser: lower-case names, values as strings or
// structured objects.
export function isAutomaticMail(headers: ReadonlyMap<string, HeaderValue>, sender: string) {
  const autoSubmitted = text(headers.get("auto-submitted")).trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  const precedence = text(headers.get("precedence")).trim().toLowerCase();
  if (["bulk", "list", "junk", "auto_reply"].includes(precedence)) return true;
  // mailparser folds List-Id, List-Post and List-Unsubscribe into "list".
  const list = headers.get("list");
  const listed =
    typeof list === "object" &&
    list !== null &&
    ("id" in list || "post" in list || "unsubscribe" in list);
  if (
    listed ||
    headers.has("list-id") ||
    headers.has("x-autoreply") ||
    headers.has("x-autorespond")
  )
    return true;
  const suppress = text(headers.get("x-auto-response-suppress")).toLowerCase();
  if (/\b(all|autoreply|oof)\b/.test(suppress)) return true;
  // An empty return path marks a delivery status notification.
  if (headers.has("return-path") && /^<?\s*>?$/.test(text(headers.get("return-path")).trim()))
    return true;
  const local = sender.slice(0, sender.lastIndexOf("@"));
  return automaticLocalParts.test(local);
}
// The text of the reminder before a ticket is resolved for want of an answer, for the customer's language.
export function reminderText(language: string, number: number, days: number, own?: string): string {
  return fillText(own ?? textKeys.autoResolveReminder.defaults[baseLanguage(language)], {
    number,
    days,
  });
}
// The text of the acknowledgement for a customer's language; a project's own
// wording replaces the built-in one.
export function acknowledgementText(language: string, number: number, own?: string): string {
  return fillText(own ?? textKeys.acknowledgement.defaults[baseLanguage(language)], { number });
}
