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
// A model provider. The product reaches the provider's own address unless the
// connection names another one (a gateway, a regional address); that address is the
// base the provider's paths are added to, and it has to be HTTPS and pass the host
// guard like any other connection's host.
export const aiConfig = z.object({
  endpoint: z.url().optional(),
  developmentOnly: z.boolean().default(false),
});
// A key of Anthropic that is not tied to one workspace needs the id of the workspace
// in a header of every request; a key made inside a workspace does not.
export const anthropicConfig = aiConfig.extend({
  workspaceId: z
    .string()
    .regex(/^wrkspc_[A-Za-z0-9]{10,}$/, "A workspace id looks like wrkspc_ and letters and digits")
    .optional()
    .describe("The workspace to use, for an Anthropic key that is not tied to one"),
});
export const aiSecret = z.object({ apiKey: z.string().min(1) });
export const aiKinds = ["anthropic", "openai", "google"] as const;
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
  "anthropic:ai": { config: anthropicConfig, secret: aiSecret, secretRequired: true },
  "openai:ai": { config: aiConfig, secret: aiSecret, secretRequired: true },
  "google:ai": { config: aiConfig, secret: aiSecret, secretRequired: true },
} as const;
export type ConnectionTypeKey = keyof typeof connectionTypes;
// The kinds and the directions of every connection type, for the schemas that
// describe a connection to the outside. Taken from the types, so a new type is in
// them without anyone listing it a second time.
const typeKeys = Object.keys(connectionTypes) as ConnectionTypeKey[];
export const connectionKinds = [...new Set(typeKeys.map((key) => key.split(":")[0] ?? ""))] as [
  string,
  ...string[],
];
export const connectionDirections = [
  ...new Set(typeKeys.map((key) => key.split(":")[1] ?? "")),
] as [string, ...string[]];
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
  "anthropic:ai": define("anthropic", "ai", anthropicConfig, aiSecret, true),
  "openai:ai": define("openai", "ai", aiConfig, aiSecret, true),
  "google:ai": define("google", "ai", aiConfig, aiSecret, true),
} as const;
export const connectionCreate = z.union([
  members["imap:inbound"],
  members["cloudflare:inbound"],
  members["smtp:outbound"],
  members["cloudflare:outbound"],
  members["anthropic:ai"],
  members["openai:ai"],
  members["google:ai"],
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
        message:
          "One of imap/inbound, cloudflare/inbound, smtp/outbound, cloudflare/outbound, anthropic/ai, openai/ai, google/ai",
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
