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
    // Provider tokens are not needed after sign-in but are kept by the
    // account model; store them encrypted.
    account: { encryptOAuthTokens: true },
    // Identity providers must be registered by an owner and their domains
    // verified. SSO never creates aidesk users; see the /sign-in/sso guard.
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
