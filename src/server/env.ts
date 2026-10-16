import { z } from "zod";
const schema = z.object({
  APP_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  // A platform that starts many short-lived instances needs few connections for each, and a pooler
  // in transaction mode does not keep prepared statements: DATABASE_PREPARE=false and a few
  // connections, DATABASE_POOL_MAX=5 (not 1: a query inside a transaction would wait for its own
  // connection). An empty value is the default.
  DATABASE_POOL_MAX: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(50).default(10),
  ),
  DATABASE_PREPARE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["true", "false"]).default("true"),
  ),
  BETTER_AUTH_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  // One-time secret for claiming the first owner; remove it after the claim.
  // An empty value, as in the example file, is no token.
  OWNER_CLAIM_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
});
let cached: z.infer<typeof schema> | undefined;
export function env(): z.infer<typeof schema> {
  cached ??= schema.parse(process.env);
  return cached;
}
