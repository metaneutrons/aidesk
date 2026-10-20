// What a reply of a customer does to a ticket that is resolved. The window of 30 days in which a reply
// reopens it was a constant; each project sets it now.
//   reopen      a reply within `days` of the resolution reopens the ticket; a later one starts a new ticket
//   new_ticket  a reply never reopens: it starts a new ticket that is linked to the old one
//   refuse      a reply is not taken: the mail is kept out as junk with the reason `reply_to_resolved`, where a
//               person can restore it (a restored mail is taken as `reopen` within the window, like any other)
export const replyModes = ["reopen", "new_ticket", "refuse"] as const;
export type ReplyMode = (typeof replyModes)[number];
export const defaultReplyMode: ReplyMode = "reopen";
export const defaultReopenDays = 30;
export const maxReopenDays = 365;
export interface ReplyPolicy {
  mode: ReplyMode;
  days: number;
}
// The policy of a project, from its settings: its own values when they are valid, the defaults otherwise.
export function replyPolicyOf(settings: Record<string, unknown>): ReplyPolicy {
  const mode = replyModes.find((entry) => entry === settings.reopenMode) ?? defaultReplyMode;
  const days = settings.reopenDays;
  return {
    mode,
    days:
      typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= maxReopenDays
        ? days
        : defaultReopenDays,
  };
}
// The automatic resolve of a ticket that waits for the customer: after `days` without an answer the ticket is
// resolved, and `reminderDays` before that the customer gets a reminder. Both are off until a project sets them.
export const maxAutoResolveDays = 365;
export interface AutoResolvePolicy {
  days: number | null;
  reminderDays: number | null;
}
const wholeDays = (value: unknown, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max ? value : null;
export function autoResolveOf(settings: Record<string, unknown>): AutoResolvePolicy {
  const days = wholeDays(settings.autoResolveDays, maxAutoResolveDays);
  const reminderDays = wholeDays(settings.autoResolveReminderDays, maxAutoResolveDays);
  // Without a time to resolve there is nothing to remind of, and a reminder comes before the resolve.
  return {
    days,
    reminderDays:
      days !== null && reminderDays !== null && reminderDays < days ? reminderDays : null,
  };
}
// Whether a reply may reopen a ticket that was resolved at `resolvedAt`, at `at`.
export function mayReopen(policy: ReplyPolicy, resolvedAt: Date | null, at: Date): boolean {
  if (policy.mode !== "reopen" || resolvedAt === null) return false;
  return at.getTime() - resolvedAt.getTime() <= policy.days * 86_400_000;
}
