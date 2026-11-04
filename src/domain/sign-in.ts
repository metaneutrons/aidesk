import { z } from "zod";
// What an operator can see of their own sign-in: how the account can be signed in to, and the sessions that are open.
// An owner has a password with a code or a passkey as the way back (see P8); every other operator signs in through the
// identity provider of their organisation. Nothing here shows a secret.
export const signInOut = z.object({
  // The account has a password. Only owners may use it to sign in.
  password: z.boolean(),
  // The account has an authenticator app (a code and backup codes).
  codes: z.boolean(),
  // The number of passkeys.
  passkeys: z.number().int().min(0),
  // The identity providers through which the account has signed in.
  providers: z.array(z.string()),
});
export const sessionOut = z.object({
  id: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  // The browser and system as the browser said it, cut; and the address the session was started from.
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  // The session that makes this request.
  current: z.boolean(),
});
export const sessionList = z.object({ sessions: z.array(sessionOut) });
export const sessionEnded = z.object({ ended: z.number().int().min(0) });
// A user agent is cut, so that a long one does not fill the list.
export const userAgentCeiling = 200;
