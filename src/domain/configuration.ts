import { z } from "zod";
import {
  defaultBusinessEnd,
  defaultBusinessStart,
  isTimeZone,
  minuteOf,
  parseDays,
  parseHolidays,
} from "./business-hours";
import { junkSensitivities } from "./junk";
import { retentionPeriod } from "./retention";
import { maxCategories, maxCategoryLength, parseCategories } from "./triage";
import { maxAutoResolveDays, maxReopenDays, replyModes } from "./reply-policy";
// The configuration of a project that people and agents may edit as one
// document. Connections, secrets and texts are not part of it; they follow with
// their own rules. The slug identifies the project and cannot be changed.
const limit = z.number().int().min(1).max(720).nullable();
export const configDocument = z
  .object({
    name: z.string().trim().min(1).max(100),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    defaultLanguage: z.enum(["en", "de"]),
    // Whether a new ticket is acknowledged to the customer by mail.
    acknowledgements: z.boolean(),
    // Whether outgoing mail carries a link to the customer's page for the ticket.
    portalLinks: z.boolean(),
    // "review": what an agent does that changes the project or reaches a customer
    // (configuration, texts, connections, replies) waits for a person; "direct":
    // it takes effect at once. People always act directly.
    approvalPolicy: z.enum(["review", "direct"]),
    // The outgoing connection that sends the project's mail; none sends nothing.
    outboundConnectionId: z.uuid().nullable(),
    // Stops all outgoing mail of the project without removing the connection.
    pauseOutgoing: z.boolean(),
    // How long a ticket may wait for an answer before it is flagged as late, and before it
    // counts as overdue. The first is never longer than the second.
    warnHours: z.number().int().min(1).max(720),
    overdueHours: z.number().int().min(1).max(720),
    // What a reply of a customer does to a resolved ticket (see `reply-policy.ts`), and for how many
    // days after the resolution a reply reopens it when the mode is "reopen".
    reopenMode: z.enum(replyModes),
    reopenDays: z.number().int().min(1).max(maxReopenDays),
    // A ticket that waits for the customer is resolved after this many days without an answer; null never
    // resolves it. The customer is reminded this many days before; null sends no reminder, and a reminder
    // comes before the resolve.
    autoResolveDays: z.number().int().min(1).max(maxAutoResolveDays).nullable(),
    autoResolveReminderDays: z.number().int().min(1).max(maxAutoResolveDays).nullable(),
    // How much the junk rules trust the headers of a mail (see `junk.ts`); the lists of senders come first.
    junkSensitivity: z.enum(junkSensitivities),
    // Business hours of the response clock (see `business-hours.ts`). Days are ISO weekdays such as "1,2,3,4,5";
    // null means no business hours, and the clock counts every hour. Holidays are dates, separated by commas
    // or line breaks.
    // Limits of the response clock for the priorities low, high and urgent; null takes the limit of the project.
    // The normal priority has the limits of the project.
    warnHoursLow: limit,
    overdueHoursLow: limit,
    warnHoursHigh: limit,
    overdueHoursHigh: limit,
    warnHoursUrgent: limit,
    overdueHoursUrgent: limit,
    // How long the project keeps what it holds, in days; null keeps it for good (see `retention.ts`). A period that
    // is set or made shorter needs a person with the right to approve changes.
    retentionTicketsDays: retentionPeriod,
    retentionAttachmentsDays: retentionPeriod,
    retentionOriginalsDays: retentionPeriod,
    retentionTranslationsDays: retentionPeriod,
    retentionAiRunsDays: retentionPeriod,
    // The categories that a ticket can have, one name per line (see `triage.ts`).
    categories: z.string().max(maxCategories * (maxCategoryLength + 1)),
    businessDays: z.string().max(13).nullable(),
    businessStart: z.string().max(5),
    businessEnd: z.string().max(5),
    businessTimeZone: z.string().max(64).nullable(),
    holidays: z.string().max(2400),
  })
  .strict()
  .refine((config) => config.warnHours <= config.overdueHours, {
    message: "The warning comes before the overdue limit or at the same time",
    path: ["warnHours"],
  })
  .refine((config) => parseCategories(config.categories) !== null, {
    message: `At most ${String(maxCategories)} names, each up to ${String(maxCategoryLength)} characters, none twice`,
    path: ["categories"],
  })
  .refine(
    (config) =>
      [
        ["Low", config.warnHoursLow, config.overdueHoursLow],
        ["High", config.warnHoursHigh, config.overdueHoursHigh],
        ["Urgent", config.warnHoursUrgent, config.overdueHoursUrgent],
      ].every(
        ([, warn, overdue]) =>
          (typeof warn === "number" ? warn : config.warnHours) <=
          (typeof overdue === "number" ? overdue : config.overdueHours),
      ),
    {
      message: "For each priority the warning comes before the overdue limit or at the same time",
      path: ["warnHours"],
    },
  )
  .refine((config) => parseHolidays(config.holidays) !== null, {
    message: "Dates like 2026-12-25, separated by commas or line breaks, at most 200",
    path: ["holidays"],
  })
  .refine((config) => config.businessDays === null || parseDays(config.businessDays) !== null, {
    message: "Weekdays from 1 (Monday) to 7 (Sunday), each once",
    path: ["businessDays"],
  })
  .refine(
    (config) =>
      config.businessDays === null ||
      (config.businessTimeZone !== null && isTimeZone(config.businessTimeZone)),
    {
      message: "Business hours need a time zone such as Europe/Berlin",
      path: ["businessTimeZone"],
    },
  )
  .refine(
    (config) => {
      const start = minuteOf(config.businessStart);
      const end = minuteOf(config.businessEnd);
      return start !== null && end !== null && (config.businessDays === null || start < end);
    },
    { message: "Times like 09:00, the end after the start", path: ["businessEnd"] },
  )
  .refine(
    (config) =>
      config.autoResolveReminderDays === null ||
      (config.autoResolveDays !== null && config.autoResolveReminderDays < config.autoResolveDays),
    {
      message: "A reminder needs a time to resolve, and comes before it",
      path: ["autoResolveReminderDays"],
    },
  );
export { defaultBusinessEnd, defaultBusinessStart };
export type ConfigDocument = z.infer<typeof configDocument>;
export const configWrite = z
  .object({
    config: configDocument,
    // The version that was read; a change made since is never overwritten unseen.
    expectedVersion: z.number().int().positive(),
    // A repeated request with the same key has the effect of one.
    idempotencyKey: z.uuid().optional(),
  })
  .strict();
export const configDecision = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export interface ConfigDiffEntry {
  pointer: string;
  from: unknown;
  to: unknown;
}
export function diffConfig(from: ConfigDocument, to: ConfigDocument): ConfigDiffEntry[] {
  return (Object.keys(configDocument.shape) as (keyof ConfigDocument)[])
    .filter((key) => from[key] !== to[key])
    .map((key) => ({ pointer: `/${key}`, from: from[key], to: to[key] }));
}
