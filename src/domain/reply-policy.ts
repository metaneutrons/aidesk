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
// Whether a reply may reopen a ticket that was resolved at `resolvedAt`, at `at`.
export function mayReopen(policy: ReplyPolicy, resolvedAt: Date | null, at: Date): boolean {
  if (policy.mode !== "reopen" || resolvedAt === null) return false;
  return at.getTime() - resolvedAt.getTime() <= policy.days * 86_400_000;
}
