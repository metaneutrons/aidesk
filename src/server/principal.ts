import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { auth } from "./auth";
import { db } from "./db";
import { agents, projects, user } from "./db/schema";
import { grantsOf } from "./grants";
import { DomainError } from "./errors";
import { env } from "./env";
import type { Grant, Principal } from "../domain/permissions";
import { archivedActions } from "./archive";
export function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
// In an archived project a person or a token keeps only the rights that read, so that nothing in it can be
// changed; every check of a right already refuses the rest.
async function readOnlyWhenArchived(grants: Grant[]): Promise<Grant[]> {
  if (grants.length === 0) return grants;
  const archived = await db()
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        inArray(
          projects.id,
          grants.map((grant) => grant.projectId),
        ),
        isNotNull(projects.archivedAt),
      ),
    );
  if (archived.length === 0) return grants;
  const shut = new Set(archived.map((row) => row.id));
  return grants.map((grant) =>
    shut.has(grant.projectId)
      ? { ...grant, actions: grant.actions.filter((action) => archivedActions.includes(action)) }
      : grant,
  );
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
      grants: await readOnlyWhenArchived([{ projectId: agent.projectId, actions: agent.actions }]),
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
  const grants = await readOnlyWhenArchived(await grantsOf(operator.id));
  return { id: operator.id, kind: "human", active: operator.active, owner: operator.owner, grants };
}
export function requireMutationOrigin(request: Request): void {
  if (
    !request.headers.has("authorization") &&
    request.headers.get("origin") !== new URL(env().APP_URL).origin
  )
    throw new DomainError("forbidden", 403);
}
