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
const texts: Record<string, (number: number) => string> = {
  de: (number) =>
    `Wir haben deine Nachricht erhalten und unter der Nummer #${String(number)} erfasst. ` +
    "Wir antworten dir, sobald wir sie bearbeitet haben.\n\n" +
    "Wenn du etwas ergänzen möchtest, antworte einfach auf diese E-Mail.",
  en: (number) =>
    `We have received your message and recorded it as #${String(number)}. ` +
    "We will reply as soon as we have looked into it.\n\n" +
    "If you would like to add anything, simply reply to this email.",
};
export function acknowledgementText(language: string, number: number): string {
  const base = language.toLowerCase().split("-")[0] ?? "en";
  return (texts[base] ?? texts.en ?? (() => ""))(number);
}
