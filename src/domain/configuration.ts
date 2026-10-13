import { z } from "zod";
// The configuration of a project that people and agents may edit as one
// document. Connections, secrets and texts are not part of it; they follow with
// their own rules. The slug identifies the project and cannot be changed.
export const configDocument = z
  .object({
    name: z.string().trim().min(1).max(100),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    defaultLanguage: z.enum(["en", "de"]),
    // Whether a new ticket is acknowledged to the customer by mail.
    acknowledgements: z.boolean(),
    // Whether outgoing mail carries a link to the customer's page for the ticket.
    portalLinks: z.boolean(),
    // "autonomous": the AI may answer under the project's rules; "off": it may not.
    aiMode: z.enum(["off", "autonomous"]),
    // "review": configuration changes by an agent wait for a person with
    // config.approve; "direct": they apply at once. People always apply directly.
    approvalPolicy: z.enum(["review", "direct"]),
    // The outgoing connection that sends the project's mail; none sends nothing.
    outboundConnectionId: z.uuid().nullable(),
    // Stops all outgoing mail of the project without removing the connection.
    pauseOutgoing: z.boolean(),
    // How long a ticket may wait for an answer before it counts as overdue.
    overdueHours: z.number().int().min(1).max(720),
  })
  .strict();
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
