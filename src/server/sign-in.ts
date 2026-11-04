import { and, desc, eq, gt, ne } from "drizzle-orm";
import { userAgentCeiling } from "../domain/sign-in";
import type { Principal } from "../domain/permissions";
import { auth } from "./auth";
import { db } from "./db";
import { account, audit, passkey, session, twoFactor } from "./db/schema";
import { DomainError } from "./errors";
// The sign-in of the signed-in operator: how the account can be signed in to, and the sessions that are open, of which
// the operator can end one or all the others. Only the sessions of the person themself; nobody ends the session of
// another person here (an owner who disables an account ends its sessions already).
function human(principal: Principal): string {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  return principal.id;
}
export async function getSignIn(principal: Principal) {
  const userId = human(principal);
  const [accounts, codes, passkeys] = await Promise.all([
    db().select({ provider: account.providerId }).from(account).where(eq(account.userId, userId)),
    db()
      .select({ id: twoFactor.id })
      .from(twoFactor)
      .where(and(eq(twoFactor.userId, userId), eq(twoFactor.verified, true))),
    db().select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, userId)),
  ]);
  return {
    password: accounts.some((entry) => entry.provider === "credential"),
    codes: codes.length > 0,
    passkeys: passkeys.length,
    providers: [
      ...new Set(accounts.map((entry) => entry.provider).filter((entry) => entry !== "credential")),
    ].sort(),
  };
}
// The id of the session that makes the request, as the cookie says; null for a request without one.
export async function currentSession(request: Request): Promise<string | null> {
  const found = await auth().api.getSession({ headers: request.headers });
  return found?.session.id ?? null;
}
export async function listSessions(principal: Principal, current: string | null) {
  const userId = human(principal);
  const rows = await db()
    .select()
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())))
    .orderBy(desc(session.createdAt));
  return {
    sessions: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      userAgent: row.userAgent ? row.userAgent.slice(0, userAgentCeiling) : null,
      ipAddress: row.ipAddress,
      current: row.id === current,
    })),
  };
}
const written = (userId: string, ended: number, scope: "one" | "others") =>
  db()
    .insert(audit)
    .values({
      actorId: userId,
      action: "operator.session_end",
      targetId: userId,
      detail: { scope, count: ended },
    });
// Ends one session of the person. The session that makes the request is not ended here: leaving is signing out.
export async function endSession(principal: Principal, current: string | null, sessionId: string) {
  const userId = human(principal);
  if (sessionId === current) throw new DomainError("conflict", 409);
  const gone = await db()
    .delete(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, userId)))
    .returning({ id: session.id });
  if (gone.length === 0) throw new DomainError("not_found", 404);
  await written(userId, 1, "one");
  return { ended: 1 };
}
// Ends every other session of the person, whatever the device.
export async function endOtherSessions(principal: Principal, current: string | null) {
  const userId = human(principal);
  const gone = await db()
    .delete(session)
    .where(and(eq(session.userId, userId), current ? ne(session.id, current) : undefined))
    .returning({ id: session.id });
  if (gone.length > 0) await written(userId, gone.length, "others");
  return { ended: gone.length };
}
