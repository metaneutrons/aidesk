import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
// Events that a project can have delivered to an endpoint of its own. An event
// carries identifiers and a few facts, never the content of a message; the
// receiver fetches what it needs through the API.
export const webhookEvents = [
  "ticket.created",
  "message.received",
  "ticket.status_changed",
  "draft.created",
  "ticket.assigned",
  "ticket.triaged",
  "ticket.warning",
  "ticket.overdue",
  "change.proposed",
  "ai.budget_low",
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];
export const webhookDescriptions: Record<WebhookEvent, string> = {
  "ticket.created": "A new ticket was opened by an inbound message",
  "message.received": "A message of a customer was added to a ticket",
  "ticket.status_changed": "A ticket was resolved or reopened",
  "draft.created": "An agent wrote a reply that waits for a person",
  "ticket.assigned": "A ticket was assigned to a person or an agent, or to nobody",
  "ticket.triaged": "The priority or the category of a ticket was set",
  "ticket.warning": "A ticket has waited for an answer as long as the warning limit of the project",
  "ticket.overdue": "A ticket has waited for an answer as long as the overdue limit of the project",
  "change.proposed": "An agent proposed a change that waits for a person",
  "ai.budget_low":
    "The use of the daily budget of an AI task reached 80 percent; sent once for a task and a day",
};
// How a delivery is written. `aidesk` is the signed JSON body of the event for a receiver of our own. Any other format
// is a channel of a messenger: the address of its incoming webhook carries its key, so it is stored sealed, never
// returned, and a delivery is not signed. The format is fixed when the webhook is made.
export const webhookFormats = [
  "aidesk",
  "slack",
  "teams",
  "discord",
  "mattermost",
  "rocketchat",
  "apprise",
] as const;
export type WebhookFormat = (typeof webhookFormats)[number];
export type ChannelFormat = Exclude<WebhookFormat, "aidesk">;
export const channelFormats = webhookFormats.filter(
  (format): format is ChannelFormat => format !== "aidesk",
);
export const isChannel = (format: string): format is ChannelFormat =>
  format !== "aidesk" && (webhookFormats as readonly string[]).includes(format);
// The events that a channel can subscribe to: those that tell people about a ticket. The others carry facts that make
// no sense as a line of text and stay with the format `aidesk`.
export const channelEvents = [
  "ticket.created",
  "ticket.assigned",
  "ticket.overdue",
  "draft.created",
  "ticket.status_changed",
] as const satisfies readonly WebhookEvent[];
export const eventsOfChannel = (values: readonly string[]): boolean =>
  values.every((value) => (channelEvents as readonly string[]).includes(value));
const name = z.string().trim().min(1).max(100);
const url = z.url().max(2000);
const events = z
  .array(z.enum(webhookEvents))
  .min(1)
  .transform((values) => [...new Set(values)]);
// The secret signs every delivery. It is set by the writer, stored sealed and
// never returned.
const secret = z.string().min(16).max(200);
export const webhookCreate = z
  .object({
    name,
    // The address of the endpoint; for a channel it carries the key of the messenger.
    url,
    events,
    format: z.enum(webhookFormats).default("aidesk"),
    // Only a channel: the subject of the ticket is part of the message. Needs config.approve to switch it on.
    withSubject: z.boolean().default(false),
    // Only the format `aidesk`: a channel does not sign.
    secret: secret.optional(),
    // Allows a plain or local endpoint, on a development stack only.
    developmentOnly: z.boolean().default(false),
    idempotencyKey: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (path: string, message: string) => {
      context.addIssue({ code: "custom", path: [path], message });
    };
    if (value.format === "aidesk") {
      if (value.secret === undefined) issue("secret", "A signing secret is required");
      if (value.withSubject) issue("withSubject", "Only a channel names the subject");
      return;
    }
    if (value.secret !== undefined) issue("secret", "A channel is not signed and has no secret");
    if (!eventsOfChannel(value.events))
      issue("events", `A channel receives only ${channelEvents.join(", ")}`);
  });
export const webhookUpdate = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: name.optional(),
    url: url.optional(),
    events: events.optional(),
    secret: secret.optional(),
    withSubject: z.boolean().optional(),
    developmentOnly: z.boolean().optional(),
    idempotencyKey: z.uuid().optional(),
  })
  .strict();
export const webhookDisable = z
  .object({ expectedVersion: z.number().int().positive(), idempotencyKey: z.uuid().optional() })
  .strict();
// The headers of a delivery. The signature covers the timestamp and the exact
// body, so a captured request cannot be replayed later or altered: a receiver
// recomputes it with its copy of the secret and refuses a timestamp that is
// more than a few minutes old.
export const signatureVersion = "v1";
export function signWebhook(secretValue: string, timestamp: number, body: string): string {
  const digest = createHmac("sha256", secretValue)
    .update(`${String(timestamp)}.${body}`)
    .digest("hex");
  return `${signatureVersion}=${digest}`;
}
export function verifyWebhook(
  secretValue: string,
  header: string,
  timestamp: number,
  body: string,
  options: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(signWebhook(secretValue, timestamp, body));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
export interface WebhookPayload {
  id: string;
  type: WebhookEvent | "ping";
  at: string;
  projectId: string;
  data: Record<string, unknown>;
}
