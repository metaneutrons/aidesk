import { betterAuth } from "better-auth";
import { randomUUID } from "node:crypto";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sso } from "@better-auth/sso";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins";
import { limitBounds } from "../domain/limits";
import { db } from "./db";
import * as schema from "./db/schema";
import { env } from "./env";
import { getLimits } from "./limits";
import { passwordSignInAllowed } from "./owner";
import { auditSsoSignIn } from "./sso-audit";
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
    // How long a session lasts is a limit that an owner sets (`sessionHours`, 12 by default), read when a
    // session starts and written as its `expiresAt`, which is what every request checks. The values
    // here are the ceiling: the cookie lives as long as the longest allowed session, and the session never
    // renews itself (`updateAge` is longer than anything), so the end that was set at the start stands.
    session: {
      expiresIn: limitBounds.sessionHours[1] * 3600,
      updateAge: 60 * 60 * 24 * 365 * 10,
      cookieCache: { enabled: false },
    },
    databaseHooks: {
      session: {
        create: {
          before: async () => ({
            data: {
              expiresAt: new Date(Date.now() + (await getLimits()).sessionHours * 3_600_000),
            },
          }),
        },
      },
    },
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
        // A sign-in through an identity provider: the callback of OIDC and the answer of SAML.
        if (
          newSession &&
          (ctx.path.startsWith("/sso/callback") || ctx.path.startsWith("/sso/saml2/sp/acs"))
        ) {
          const named = (ctx.params as Record<string, unknown> | undefined)?.providerId;
          await auditSsoSignIn(newSession.user.id, typeof named === "string" ? named : undefined);
        }
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
