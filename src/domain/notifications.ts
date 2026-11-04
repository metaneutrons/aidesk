import { z } from "zod";
// Notifications for operators (M9-A1). An event of a project (a new ticket, an assignment, a note that names
// someone, a ticket that is overdue, a draft of an agent that waits) can reach the operators of the project in the
// desk and by mail. The project sets which events notify whom; each operator sets for each kind whether it reaches
// them in the desk and by mail. A notification never holds more than the kind, the ticket and the time; the subject
// of the ticket and the link are read when it is shown or sent.
export const notificationKinds = [
  "new_ticket",
  "assignment",
  "mention",
  "overdue",
  "draft",
] as const;
export type NotificationKind = (typeof notificationKinds)[number];
// Who a rule reaches. "assignee" is the person the ticket is assigned to, and everybody who may reply when it is
// assigned to nobody (or to an agent), so that nothing is lost; "members" is everybody who may reply.
export const recipientModes = ["off", "assignee", "members"] as const;
export type RecipientMode = (typeof recipientModes)[number];
// The modes that make sense for a kind: a new ticket has no assignee yet, an assignment and a mention name their
// person themselves.
export const modesOf: Record<NotificationKind, readonly RecipientMode[]> = {
  new_ticket: ["off", "members"],
  assignment: ["off", "assignee"],
  mention: ["off", "assignee"],
  overdue: recipientModes,
  draft: recipientModes,
};
export const ruleDefaults: Record<NotificationKind, RecipientMode> = {
  new_ticket: "off",
  assignment: "assignee",
  mention: "assignee",
  overdue: "assignee",
  draft: "assignee",
};
// The keys of the configuration of a project.
export const ruleKeys = {
  new_ticket: "notifyNewTicket",
  assignment: "notifyAssignment",
  mention: "notifyMention",
  overdue: "notifyOverdue",
  draft: "notifyDraft",
} as const satisfies Record<NotificationKind, string>;
export type RuleKey = (typeof ruleKeys)[NotificationKind];
export type NotificationRules = Record<RuleKey, RecipientMode>;
const modeOf = (kind: NotificationKind, value: unknown): RecipientMode =>
  modesOf[kind].find((mode) => mode === value) ?? ruleDefaults[kind];
// The rules as a project stores them; a value that is missing or not valid reads as the default.
export function rulesOf(settings: Record<string, unknown>): NotificationRules {
  return Object.fromEntries(
    notificationKinds.map((kind) => [ruleKeys[kind], modeOf(kind, settings[ruleKeys[kind]])]),
  ) as NotificationRules;
}
export const ruleShape = {
  notifyNewTicket: z.enum(modesOf.new_ticket as readonly [RecipientMode, ...RecipientMode[]]),
  notifyAssignment: z.enum(modesOf.assignment as readonly [RecipientMode, ...RecipientMode[]]),
  notifyMention: z.enum(modesOf.mention as readonly [RecipientMode, ...RecipientMode[]]),
  notifyOverdue: z.enum(recipientModes),
  notifyDraft: z.enum(recipientModes),
};
// What an operator chose for a kind. Without a choice both channels are on.
export const preferenceDefaults = { desk: true, mail: true } as const;
export const preferenceInput = z
  .object({
    preferences: z
      .array(
        z
          .object({
            kind: z.enum(notificationKinds),
            desk: z.boolean(),
            mail: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(notificationKinds.length),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.preferences.map((entry) => entry.kind)).size === input.preferences.length,
    {
      message: "A kind is named once",
      path: ["preferences"],
    },
  );
export const preferenceOut = z.object({
  preferences: z.array(
    z.object({ kind: z.enum(notificationKinds), desk: z.boolean(), mail: z.boolean() }),
  ),
});
export const notificationOut = z.object({
  id: z.uuid(),
  kind: z.enum(notificationKinds),
  projectId: z.uuid(),
  projectName: z.string(),
  ticketId: z.uuid().nullable(),
  ticketNumber: z.number().int().nullable(),
  subject: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export const notificationPage = z.object({
  notifications: z.array(notificationOut),
  unread: z.number().int().min(0),
  next: z.string().nullable(),
});
export const notificationQuery = z.object({
  unread: z.enum(["true", "false"]).optional(),
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const readInput = z.object({ ids: z.array(z.uuid()).min(1).max(100).optional() }).strict();
export const readOut = z.object({ read: z.number().int().min(0) });
// Notifications older than this are removed (read or not), so that the list does not grow without end.
export const keepDays = 90;
