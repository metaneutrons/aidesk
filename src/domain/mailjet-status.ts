// What the status of a message in the Mailjet API says about its delivery
// (GET /v3/REST/message/{id}), and when to ask again.
export interface MailjetMessageStatus {
  status: string;
  stateId: number | null;
  permanent: boolean | null;
}
export type MailjetOutcome =
  { kind: "failed"; diagnostic: string } | { kind: "delivered" } | { kind: "pending" };
// The reason of a failure by the groups of StateID that the documentation names: 1 to 3 the recipient,
// 4 to 6 the domain, 7 to 9 spam filtering, 10 to 12 the system, 13 greylisting, 14 to 16 prevented by
// Mailjet, 17 and 18 the content, 19 a typo fix, 20 the recipient is blacklisted, 21 a spam report.
export function stateReason(stateId: number | null): string | null {
  if (stateId === null) return null;
  const groups: [number, number, string][] = [
    [1, 3, "recipient"],
    [4, 6, "domain"],
    [7, 9, "spam filter"],
    [10, 12, "system"],
    [13, 13, "greylisted"],
    [14, 16, "prevented by Mailjet"],
    [17, 18, "content"],
    [19, 19, "typo fix"],
    [20, 20, "recipient blacklisted"],
    [21, 21, "spam report"],
  ];
  return groups.find(([from, to]) => stateId >= from && stateId <= to)?.[2] ?? null;
}
// A message has failed when Mailjet calls it a hard bounce or blocked, or marks the state as permanent.
// A soft bounce and a deferral are retried by Mailjet and are not final. "sent" is delivery to the
// recipient's server, and a report of spam or an unsubscribe follows a delivery.
export function interpretStatus(value: MailjetMessageStatus): MailjetOutcome {
  const status = /^[a-z]{2,20}$/.test(value.status) ? value.status : "unknown";
  if (status === "hardbounced" || status === "blocked" || value.permanent === true) {
    const reason = stateReason(value.stateId);
    const state = value.stateId === null ? "" : `, state ${String(value.stateId)}`;
    return {
      kind: "failed",
      diagnostic: `Mailjet: ${status}${state}${reason ? ` (${reason})` : ""}`,
    };
  }
  return ["sent", "opened", "clicked", "spam", "unsub"].includes(status)
    ? { kind: "delivered" }
    : { kind: "pending" };
}
// The checks happen once the message has had a minute to be processed, then at growing distances, so
// that a bounce that comes back late is still seen. After the last one a message is not asked about again.
export const firstCheckDelayMs = 60_000;
export const checkDelaysMs = [2, 10, 30, 120, 360, 1440].map((minutes) => minutes * 60_000);
export function nextCheckAt(checks: number, from: Date): Date | null {
  const delay = checkDelaysMs[checks];
  return delay === undefined ? null : new Date(from.getTime() + delay);
}
