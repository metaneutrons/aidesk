import { eq } from "drizzle-orm";
import {
  limitBounds,
  limitDefaults,
  limitKeys,
  limitsInput,
  type LimitKey,
  type Limits,
} from "../domain/limits";
import type { Principal } from "../domain/permissions";
import type { Tx } from "./changes";
import { db } from "./db";
import { audit, workspaceSettings } from "./db/schema";
import { DomainError } from "./errors";
// The limits of the installation (see the domain module for what they are), kept in one row of the
// workspace settings. A missing row, a missing field and a stored value that is not an integer inside its
// bounds all mean the default, so that a damaged row can never open a limit.
let key = "limits";
// For tests only, like the switches of the workspace: the test files run side by side against one
// database, and a limit of the whole installation would change what the others check.
export function useLimitsKey(name: string): void {
  key = name;
}
function merged(stored: Record<string, unknown> | undefined): Limits {
  const found = { ...limitDefaults } as Limits;
  for (const name of limitKeys) {
    const value = stored?.[name];
    const [low, high] = limitBounds[name];
    if (typeof value === "number" && Number.isInteger(value) && value >= low && value <= high)
      found[name] = value;
  }
  return found;
}
export async function getLimits(reader: Pick<Tx, "select"> = db()): Promise<Limits> {
  const [row] = await reader.select().from(workspaceSettings).where(eq(workspaceSettings.key, key));
  return merged(row?.value);
}
export async function readLimits(principal: Principal): Promise<Limits> {
  if (principal.kind !== "human") throw new DomainError("forbidden", 403);
  if (!principal.owner) throw new DomainError("forbidden", 403);
  return getLimits();
}
// Sets the named limits and leaves the others as they are. A value that equals the default is stored as
// it is: the default may change in a later version, and what an owner chose stays what they chose.
export async function setLimits(principal: Principal, input: unknown): Promise<Limits> {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  if (!principal.owner) throw new DomainError("forbidden", 403);
  const values = limitsInput.parse(input);
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.key, key))
      .for("update");
    const before = merged(row?.value);
    const named = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined),
    ) as Partial<Record<LimitKey, number>>;
    const after: Limits = { ...before, ...named };
    const changed = limitKeys.filter((name) => before[name] !== after[name]);
    if (changed.length === 0) return after;
    await tx
      .insert(workspaceSettings)
      .values({ key, value: { ...(row?.value ?? {}), ...named }, updatedBy: principal.id })
      .onConflictDoUpdate({
        target: workspaceSettings.key,
        set: {
          value: { ...(row?.value ?? {}), ...named },
          updatedBy: principal.id,
          updatedAt: new Date(),
        },
      });
    await tx.insert(audit).values({
      actorId: principal.id,
      action: "workspace.limits",
      detail: {
        changed: Object.fromEntries(
          changed.map((name) => [name, { from: before[name], to: after[name] }]),
        ),
      },
    });
    return after;
  });
}
