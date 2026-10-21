import { eq } from "drizzle-orm";
import { profileInput } from "../domain/profile";
import type { Principal } from "../domain/permissions";
import { db } from "./db";
import { audit, user } from "./db/schema";
import { DomainError } from "./errors";
// The display name and the signature of the signed-in operator. Only they set them, for themselves; a person who
// manages a project does not write under another name. A reply that this person writes carries both (see `reply`).
function human(principal: Principal): string {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  return principal.id;
}
export async function getProfile(principal: Principal) {
  const [row] = await db()
    .select({
      name: user.name,
      displayName: user.displayName,
      signature: user.signature,
      timeZone: user.timeZone,
    })
    .from(user)
    .where(eq(user.id, human(principal)));
  if (!row) throw new DomainError("not_found", 404);
  return row;
}
export async function setProfile(principal: Principal, input: unknown) {
  const id = human(principal);
  const values = profileInput.parse(input);
  await db().transaction(async (tx) => {
    await tx
      .update(user)
      .set({
        ...(values.displayName !== undefined ? { displayName: values.displayName } : {}),
        ...(values.signature !== undefined ? { signature: values.signature } : {}),
        ...(values.timeZone !== undefined ? { timeZone: values.timeZone } : {}),
        updatedAt: new Date(),
      })
      .where(eq(user.id, id));
    // The entry names the fields, not their text.
    await tx.insert(audit).values({
      actorId: id,
      action: "operator.profile",
      targetId: id,
      detail: { fields: Object.keys(values) },
    });
  });
  return getProfile(principal);
}
