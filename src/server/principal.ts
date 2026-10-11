import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { auth } from "./auth";
import { db } from "./db";
import { agents, memberships, user } from "./db/schema";
import { DomainError } from "./errors";
import { env } from "./env";
import type { Principal } from "../domain/permissions";
export function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export async function identify(headers: Headers): Promise<Principal> {
  const bearer = headers.get("authorization");
  if (bearer) {
    if (!bearer.startsWith("Bearer ")) throw new DomainError("unauthenticated", 401);
    const [agent] = await db()
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.tokenHash, tokenHash(bearer.slice(7))),
          eq(agents.active, true),
          gt(agents.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!agent) throw new DomainError("unauthenticated", 401);
    return {
      id: agent.id,
      kind: "agent",
      active: true,
      owner: false,
      grants: [{ projectId: agent.projectId, actions: agent.actions }],
    };
  }
  const authenticated = await auth().api.getSession({ headers });
  if (!authenticated) throw new DomainError("unauthenticated", 401);
  const [operator] = await db()
    .select()
    .from(user)
    .where(eq(user.id, authenticated.user.id))
    .limit(1);
  if (!operator?.active) throw new DomainError("unauthenticated", 401);
  const grants = await db()
    .select({ projectId: memberships.projectId, actions: memberships.actions })
    .from(memberships)
    .where(eq(memberships.userId, operator.id));
  return { id: operator.id, kind: "human", active: operator.active, owner: operator.owner, grants };
}
export function requireMutationOrigin(request: Request): void {
  if (
    !request.headers.has("authorization") &&
    request.headers.get("origin") !== new URL(env().APP_URL).origin
  )
    throw new DomainError("forbidden", 403);
}
