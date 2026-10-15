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
  "change.proposed",
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];
export const webhookDescriptions: Record<WebhookEvent, string> = {
  "ticket.created": "A new ticket was opened by an inbound message",
  "message.received": "A message of a customer was added to a ticket",
  "ticket.status_changed": "A ticket was resolved or reopened",
  "draft.created": "An agent wrote a reply that waits for a person",
  "ticket.assigned": "A ticket was assigned to a person or an agent, or to nobody",
  "change.proposed": "An agent proposed a change that waits for a person",
};
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
    url,
    events,
    secret,
    // Allows a plain or local endpoint, on a development stack only.
    developmentOnly: z.boolean().default(false),
    idempotencyKey: z.uuid().optional(),
  })
  .strict();
export const webhookUpdate = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: name.optional(),
    url: url.optional(),
    events: events.optional(),
    secret: secret.optional(),
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
