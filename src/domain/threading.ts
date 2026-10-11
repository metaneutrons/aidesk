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
