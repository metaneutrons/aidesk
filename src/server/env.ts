import { z } from "zod";
const schema = z.object({
  APP_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  // A platform that starts many short-lived instances needs few connections for each, and a pooler
  // in transaction mode does not keep prepared statements: DATABASE_POOL_MAX=1 and
  // DATABASE_PREPARE=false. An empty value is the default.
  DATABASE_POOL_MAX: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(50).default(10),
  ),
  DATABASE_PREPARE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["true", "false"]).default("true"),
  ),
  BETTER_AUTH_SECRET: z.string().min(32),
  // While the secret is rotated the previous one stays here, so that nothing that it protects is lost before the
  // keys job has re-protected it; `BETTER_AUTH_SECRET_VERSION` numbers the current secret (the previous one is one
  // less) and is raised by one with each rotation. An empty value is no previous secret.
  BETTER_AUTH_SECRET_PREVIOUS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  BETTER_AUTH_SECRET_VERSION: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(1_000_000).default(1),
  ),
  ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  // The key that sealed the stored secrets before the last rotation; it is only used to read what the keys job has not
  // re-sealed yet. An empty value is no previous key.
  ENCRYPTION_KEY_PREVIOUS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  ),
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
  // Lets an owner who lost the password set a new one at /recover, together with a code of the
  // authenticator or a backup code. It can stay set; without it the recovery does not exist.
  OWNER_RECOVERY_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
});
let cached: z.infer<typeof schema> | undefined;
// The values are read once; a test that changes the environment reads them again.
export function resetEnv(): void {
  cached = undefined;
}
export function env(): z.infer<typeof schema> {
  cached ??= schema.parse(process.env);
  return cached;
}
