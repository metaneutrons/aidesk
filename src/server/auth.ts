import { betterAuth } from "better-auth";
import { randomUUID } from "node:crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sso } from "@better-auth/sso";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins";
import { db } from "./db";
import * as schema from "./db/schema";
import { env } from "./env";
import { passwordSignInAllowed } from "./owner";
import { auditPasskeySignIn, guardPasskeyRoutes, passkeys2FA, passkeyStatus } from "./passkey";
function createAuth() {
  return betterAuth({
    appName: "aidesk",
    baseURL: env().APP_URL,
    secret: env().BETTER_AUTH_SECRET,
    database: drizzleAdapter(db(), { provider: "pg", schema }),
    trustedOrigins: [env().APP_URL],
    // Only owners with TOTP may use a password (see hooks.before); it is their
    // recovery path when the identity provider is unavailable.
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: { expiresIn: 60 * 60 * 12, cookieCache: { enabled: false } },
    // Provider tokens are not needed after sign-in but are kept by the
    // account model; store them encrypted.
    account: { encryptOAuthTokens: true },
    // Identity providers must be registered by an owner and their domains
    // verified. SSO never creates aidesk users; see the /sign-in/sso guard.
    plugins: [
      sso({ domainVerification: { enabled: true }, disableImplicitSignUp: true }),
      twoFactor({ issuer: "aidesk" }),
      passkeys2FA(),
      passkeyStatus(),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith("/passkey/")) {
          await guardPasskeyRoutes(ctx.path, ctx as Parameters<typeof guardPasskeyRoutes>[1]);
          return;
        }
        if (ctx.path !== "/sign-in/email") return;
        const body: unknown = ctx.body;
        const email =
          typeof body === "object" &&
          body !== null &&
          "email" in body &&
          typeof body.email === "string"
            ? body.email
            : "";
        if (await passwordSignInAllowed(email)) return;
        // Same answer and comparable work as a wrong password, so the response
        // does not reveal who is an owner.
        await hashPassword(randomUUID());
        throw new APIError("UNAUTHORIZED", {
          message: "Invalid email or password",
          code: "INVALID_EMAIL_OR_PASSWORD",
        });
      }),
      after: createAuthMiddleware(async (ctx) => {
        const newSession = ctx.context.newSession;
        if (newSession && ctx.path === "/passkey/verify-authentication")
          await auditPasskeySignIn(newSession.user.id);
        if (
          newSession &&
          (ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/verify-backup-code")
        )
          await db()
            .insert(schema.audit)
            .values({
              actorId: newSession.user.id,
              action: "owner.recovery_sign_in",
              detail: { method: ctx.path.endsWith("totp") ? "totp" : "backup_code" },
            });
      }),
    },
    advanced: { database: { generateId: () => randomUUID() } },
    logger: { disabled: true },
  });
}
let cached: ReturnType<typeof createAuth> | undefined;
export function auth(): ReturnType<typeof createAuth> {
  cached ??= createAuth();
  return cached;
}
