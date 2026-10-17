import { and, eq, sql } from "drizzle-orm";
import { passkey, type PasskeyOptions } from "@better-auth/passkey";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { db } from "./db";
import { audit, passkey as passkeys, user } from "./db/schema";
import { env } from "./env";
// A passkey is the second factor of an owner, after the password and in place of the code of the
// authenticator app; the code and the backup codes stay as the way back. It is never a way in on its
// own: the verification of an assertion needs the pending step that the password sign-in leaves, the
// passkey has to be that user's, and the user has to have been verified by the device.
type Verification = NonNullable<NonNullable<PasskeyOptions["authentication"]>["afterVerification"]>;
type Context = Parameters<Verification>[0]["ctx"];
const pendingCookie = "two_factor";
// The user that has passed the password and waits for the second factor, from the signed cookie of
// that step, and the key of the step.
async function pendingStep(ctx: Context): Promise<{ userId: string; key: string } | null> {
  const cookie = ctx.context.createAuthCookie(pendingCookie);
  const key = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!key) return null;
  const found = await ctx.context.internalAdapter.findVerificationValue(key);
  if (!found || found.expiresAt.getTime() <= Date.now()) return null;
  return { userId: found.value, key };
}
const refused = () =>
  new APIError("UNAUTHORIZED", { message: "Invalid passkey", code: "PASSKEY_NOT_ACCEPTED" });
export function passkeys2FA() {
  const origin = new URL(env().APP_URL);
  return passkey({
    rpName: "aidesk",
    rpID: origin.hostname,
    origin: origin.origin,
    // Discoverable credentials with user verification: what is called a passkey.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    authentication: {
      afterVerification: async ({ ctx, verification, clientData }) => {
        const pending = await pendingStep(ctx);
        if (!pending) throw refused();
        const [owned] = await db()
          .select({ userId: passkeys.userId })
          .from(passkeys)
          .where(eq(passkeys.credentialID, clientData.id))
          .limit(1);
        // Only the passkey of the user who passed the password counts, and only with the user verified.
        if (owned?.userId !== pending.userId || !verification.authenticationInfo.userVerified)
          throw refused();
        // The step is used up by this assertion.
        const consumed = await ctx.context.internalAdapter
          .consumeVerificationValue(pending.key)
          .catch(() => null);
        if (consumed?.value !== pending.userId) throw refused();
        ctx.setCookie(ctx.context.createAuthCookie(pendingCookie).name, "", {
          maxAge: 0,
          path: "/",
        });
      },
    },
  });
}
// Whether the user of the pending step has a passkey, so that the sign-in page offers it first.
export function passkeyStatus() {
  return {
    id: "owner-passkey-status",
    endpoints: {
      passkeyStatus: createAuthEndpoint("/owner-passkey/status", { method: "GET" }, async (ctx) => {
        const pending = await pendingStep(ctx);
        if (!pending) throw refused();
        const [row] = await db()
          .select({ count: sql<number>`count(*)::int` })
          .from(passkeys)
          .where(eq(passkeys.userId, pending.userId));
        return ctx.json({ passkey: (row?.count ?? 0) > 0 });
      }),
    },
  } as const;
}
// Only owners have passkeys (they are the ones with a local credential), and one asks for an
// assertion only in the pending step of a password.
export async function guardPasskeyRoutes(path: string, ctx: Context): Promise<void> {
  if (path === "/passkey/generate-authenticate-options") {
    if (!(await pendingStep(ctx))) throw refused();
    return;
  }
  if (path === "/passkey/generate-register-options" || path === "/passkey/verify-registration") {
    const session = await getSessionFromCtx(ctx);
    if (!session) throw new APIError("UNAUTHORIZED", { message: "Sign in first" });
    const [owner] = await db()
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.id, session.user.id), eq(user.owner, true), eq(user.active, true)))
      .limit(1);
    if (!owner) throw new APIError("FORBIDDEN", { message: "Only an owner has passkeys" });
  }
}
export async function auditPasskeySignIn(userId: string): Promise<void> {
  await db()
    .insert(audit)
    .values({ actorId: userId, action: "owner.recovery_sign_in", detail: { method: "passkey" } });
}
