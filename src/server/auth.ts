import { betterAuth } from "better-auth";
import { randomUUID } from "node:crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sso } from "@better-auth/sso";
import { db } from "./db";
import * as schema from "./db/schema";
import { env } from "./env";
function createAuth() {
  return betterAuth({
    appName: "aidesk",
    baseURL: env().APP_URL,
    secret: env().BETTER_AUTH_SECRET,
    database: drizzleAdapter(db(), { provider: "pg", schema }),
    trustedOrigins: [env().APP_URL],
    emailAndPassword: {
      enabled: process.env.DEV_BOOTSTRAP === "true" && process.env.NODE_ENV === "development",
      disableSignUp: true,
    },
    session: { expiresIn: 60 * 60 * 12, cookieCache: { enabled: false } },
    plugins: [sso({ domainVerification: { enabled: true }, disableImplicitSignUp: true })],
    advanced: { database: { generateId: () => randomUUID() } },
    logger: { disabled: true },
  });
}
let cached: ReturnType<typeof createAuth> | undefined;
export function auth(): ReturnType<typeof createAuth> {
  cached ??= createAuth();
  return cached;
}
