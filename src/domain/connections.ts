import { z } from "zod";
// The connections a project can have and what each one needs. The same schemas
// serve the adapters that use a connection and the API that defines one, so a
// connection that can be saved is one that can be used. The secret of a
// connection is stored sealed and is never returned.
export const imapConfig = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().min(1),
  mailbox: z.string().min(1).default("INBOX"),
  // Folder for junk; when absent, the server's \\Junk folder is used.
  junkMailbox: z.string().min(1).optional(),
  developmentOnly: z.boolean().default(false),
});
export const imapSecret = z.object({ pass: z.string().min(1) });
export const cloudflareInboundConfig = z.object({
  endpoint: z.url(),
  bucket: z.string().min(1),
  address: z.email(),
  region: z.string().min(1).default("auto"),
  developmentOnly: z.boolean().default(false),
});
export const cloudflareInboundSecret = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});
export const cloudflareOutboundConfig = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  from: z.email(),
  replyTo: z.email(),
});
export const cloudflareOutboundSecret = z.object({ apiToken: z.string().min(1) });
export const smtpConfig = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  from: z.email(),
  replyTo: z.email(),
  developmentOnly: z.boolean().default(false),
  suppressionCheck: z.enum(["smtp2go"]).optional(),
});
export const smtpSecret = z.object({
  user: z.string(),
  pass: z.string(),
  apiKey: z.string().min(1).optional(),
});
// One entry per kind and direction: how to check its configuration and secret.
export const connectionTypes = {
  "imap:inbound": { config: imapConfig, secret: imapSecret, secretRequired: true },
  "cloudflare:inbound": {
    config: cloudflareInboundConfig,
    secret: cloudflareInboundSecret,
    secretRequired: true,
  },
  "smtp:outbound": { config: smtpConfig, secret: smtpSecret, secretRequired: false },
  "cloudflare:outbound": {
    config: cloudflareOutboundConfig,
    secret: cloudflareOutboundSecret,
    secretRequired: true,
  },
} as const;
export type ConnectionTypeKey = keyof typeof connectionTypes;
export function typeKey(kind: string, direction: string): ConnectionTypeKey | null {
  const key = `${kind}:${direction}`;
  return key in connectionTypes ? (key as ConnectionTypeKey) : null;
}
const name = z.string().trim().min(1).max(100);
const idempotencyKey = z.uuid().optional();
// The request bodies, one shape per kind so that the published definition
// names the fields of each. developmentOnly is accepted only on a development
// stack (checked by the operation).
const define = <K extends string, D extends string, C extends z.ZodType, S extends z.ZodType>(
  kind: K,
  direction: D,
  config: C,
  secret: S,
  secretRequired: boolean,
) =>
  z
    .object({
      kind: z.literal(kind),
      direction: z.literal(direction),
      name,
      config,
      secret: secretRequired ? secret : secret.optional(),
      idempotencyKey,
    })
    .strict();
const members = {
  "imap:inbound": define("imap", "inbound", imapConfig, imapSecret, true),
  "cloudflare:inbound": define(
    "cloudflare",
    "inbound",
    cloudflareInboundConfig,
    cloudflareInboundSecret,
    true,
  ),
  "smtp:outbound": define("smtp", "outbound", smtpConfig, smtpSecret, false),
  "cloudflare:outbound": define(
    "cloudflare",
    "outbound",
    cloudflareOutboundConfig,
    cloudflareOutboundSecret,
    true,
  ),
} as const;
export const connectionCreate = z.union([
  members["imap:inbound"],
  members["cloudflare:inbound"],
  members["smtp:outbound"],
  members["cloudflare:outbound"],
]);
export type ConnectionCreate = z.infer<typeof connectionCreate>;
// Reads a definition by its kind and direction first, so that an error names the
// field of that kind and not the whole set of alternatives.
export function parseConnectionCreate(input: unknown): ConnectionCreate {
  const head = z.object({ kind: z.string(), direction: z.string() }).safeParse(input);
  const key = head.success ? typeKey(head.data.kind, head.data.direction) : null;
  if (!key)
    throw new z.ZodError([
      {
        code: "custom",
        path: ["kind"],
        message: "One of imap/inbound, cloudflare/inbound, smtp/outbound, cloudflare/outbound",
      },
    ]);
  return members[key].parse(input);
}
// A change names the version it read. config and secret each replace the whole
// stored value when present; leaving the secret out keeps the stored one.
export const connectionUpdate = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: name.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    secret: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey,
  })
  .strict();
export const connectionDisable = z
  .object({ expectedVersion: z.number().int().positive(), idempotencyKey })
  .strict();
