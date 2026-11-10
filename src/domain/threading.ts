// A msg-id in angle brackets (RFC 5322) without whitespace, so it cannot
// inject header lines.
const messageIdPattern = /^<[^<>\s@]+@[^<>\s@]+>$/;
export function isMessageId(value: unknown): value is string {
  return typeof value === "string" && messageIdPattern.test(value);
}
export interface ThreadEntry {
  messageId: unknown;
  fromCustomer: boolean;
}
// Builds In-Reply-To and References for a reply from the earlier public
// messages of a ticket, oldest first. In-Reply-To names the latest customer
// message; References keeps the thread root and the most recent entries.
export function threadHeaders(
  history: readonly ThreadEntry[],
  limit = 20,
): { inReplyTo?: string; references?: string } {
  const known = history.filter((entry): entry is ThreadEntry & { messageId: string } =>
    isMessageId(entry.messageId),
  );
  const last = known.at(-1);
  if (!last) return {};
  const parent = known.filter((entry) => entry.fromCustomer).at(-1) ?? last;
  const ids = [...new Set(known.map((entry) => entry.messageId))];
  const kept = ids.length > limit ? [ids[0] ?? "", ...ids.slice(ids.length - limit + 1)] : ids;
  return { inReplyTo: parent.messageId, references: kept.join(" ") };
}
// The Message-ID that Mailjet gives to a mail has the form <hex.base64url@mailjet.com>, and the first
// eight bytes of the decoded second part are the numeric id of the message in the Mailjet API (the
// providerId of the sent mail). Seen in eight mails of 10 November 2026 from three sender domains, not documented by Mailjet: a value
// that does not have this form yields null.
const mailjetIdPattern = /^<[0-9a-f]{4,16}\.([A-Za-z0-9_-]{11,200})@mailjet\.com>$/;
export function mailjetProviderId(value: unknown): string | null {
  const encoded = typeof value === "string" ? mailjetIdPattern.exec(value)?.[1] : undefined;
  if (!encoded) return null;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length < 8) return null;
  const id = bytes.readBigUInt64BE(0);
  return id > 0n && id < 2n ** 63n ? id.toString() : null;
}
