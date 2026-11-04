import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq, gt, isNotNull, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Principal } from "../domain/permissions";
import { db } from "./db";
import { audit, connections, twoFactor, verification, webhooks } from "./db/schema";
import { DomainError } from "./errors";
import { env } from "./env";
import { authSecrets, sealSecret, sealState, unsealSecret } from "./secrets";
// Rotating `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` without losing what they protect. The operator sets the new value
// in the variable and the old value in `..._PREVIOUS` (and raises `BETTER_AUTH_SECRET_VERSION` by one), restarts, and the
// owner starts this run, which re-protects every stored value with the current key. Reading works with either key while
// the previous one is set, and each value is rewritten on its own, so a run that stops halfway (an unreadable value, a
// restart) leaves every value readable and can be repeated; nothing is lost before the previous key is removed, which
// the operator does when the status says that no value depends on it any more.
//
// Protected with `ENCRYPTION_KEY`: the secrets of connections and webhooks, the configuration of single sign-on, and
// the secrets in proposals that wait for approval. Protected with `BETTER_AUTH_SECRET`: the authenticator and the
// backup codes of the owners and the claims and recoveries of an owner that are under way. The session cookies are
// signed with the current secret, so a session that was started under the previous one ends with the change of the
// secret and its person signs in again; links of the customer page that were issued under the previous encryption
// key stay valid while it is kept and end when it is removed.
export interface KeyGroup {
  name: string;
  key: "encryption" | "auth";
  total: number;
  // Protected with the current key.
  current: number;
  // Still protected with the previous key (before the run) and re-protected by it (after).
  previous: number;
  // Neither key opens it: left as it is.
  unreadable: number;
}
interface Row {
  value: string;
  write: (value: string) => Promise<boolean>;
}
const owner = (principal: Principal) => {
  if (principal.kind !== "human" || !principal.active || !principal.owner)
    throw new DomainError("forbidden", 403);
};
// Open with either key and protect again with the current one.
async function authState(value: string): Promise<"current" | "previous" | "unreadable"> {
  const { config } = authSecrets();
  const versioned = /^\$ba\$(\d+)\$/.exec(value);
  try {
    await symmetricDecrypt({ key: config, data: value });
  } catch {
    return "unreadable";
  }
  return versioned && Number(versioned[1]) === config.currentVersion ? "current" : "previous";
}
const authReseal = async (value: string) => {
  const { config } = authSecrets();
  return symmetricEncrypt({
    key: config,
    data: await symmetricDecrypt({ key: config, data: value }),
  });
};
async function groups(): Promise<{ name: string; key: KeyGroup["key"]; rows: Row[] }[]> {
  const connectionRows = await db()
    .select({ id: connections.id, value: connections.secretCiphertext })
    .from(connections)
    .where(isNotNull(connections.secretCiphertext));
  const webhookRows = await db()
    .select({ id: webhooks.id, value: webhooks.secretCiphertext })
    .from(webhooks);
  const sso = await db().execute<{ id: string; oidc: string | null; saml: string | null }>(
    sql`select id, oidc_config as oidc, saml_config as saml from sso_provider`,
  );
  const proposals = await db().execute<{ id: string; value: string }>(sql`
    select id, payload->>'secret' as value from config_change
    where status = 'pending' and jsonb_typeof(payload->'secret') = 'string'`);
  const factors = await db().select().from(twoFactor);
  const claims = await db()
    .select({ id: verification.id, value: verification.value })
    .from(verification)
    .where(
      and(
        or(
          like(verification.identifier, "owner-claim-%"),
          like(verification.identifier, "owner-recovery-%"),
        ),
        gt(verification.expiresAt, new Date()),
      ),
    );
  const sealedRow = (
    value: string,
    update: (next: string, old: string) => Promise<number | { count: number }>,
  ): Row => ({
    value,
    write: async (next) => {
      const result = await update(next, value);
      return (typeof result === "number" ? result : result.count) > 0;
    },
  });
  return [
    {
      name: "connections",
      key: "encryption",
      rows: connectionRows.flatMap((row) =>
        row.value === null
          ? []
          : [
              sealedRow(
                row.value,
                async (next, old) =>
                  (
                    await db()
                      .update(connections)
                      .set({ secretCiphertext: next })
                      .where(and(eq(connections.id, row.id), eq(connections.secretCiphertext, old)))
                      .returning({ id: connections.id })
                  ).length,
              ),
            ],
      ),
    },
    {
      name: "webhooks",
      key: "encryption",
      rows: webhookRows.map((row) =>
        sealedRow(
          row.value,
          async (next, old) =>
            (
              await db()
                .update(webhooks)
                .set({ secretCiphertext: next })
                .where(and(eq(webhooks.id, row.id), eq(webhooks.secretCiphertext, old)))
                .returning({ id: webhooks.id })
            ).length,
        ),
      ),
    },
    {
      name: "sso",
      key: "encryption",
      rows: [...sso].flatMap((row) =>
        (["oidc", "saml"] as const).flatMap((kind) => {
          const value = row[kind];
          if (value === null) return [];
          const column = sql.raw(kind === "oidc" ? "oidc_config" : "saml_config");
          return [
            sealedRow(value, async (next, old) =>
              db().execute(
                sql`update sso_provider set ${column} = ${next} where id = ${row.id} and ${column} = ${old}`,
              ),
            ),
          ];
        }),
      ),
    },
    {
      name: "proposals",
      key: "encryption",
      rows: [...proposals].map((row) =>
        sealedRow(row.value, async (next, old) =>
          db().execute(sql`
            update config_change set payload = jsonb_set(payload, '{secret}', to_jsonb(${next}::text))
            where id = ${row.id} and status = 'pending' and payload->>'secret' = ${old}`),
        ),
      ),
    },
    {
      name: "owner_factors",
      key: "auth",
      rows: factors.flatMap((row) =>
        (["secret", "backupCodes"] as const).map((column) =>
          sealedRow(
            row[column],
            async (next, old) =>
              (
                await db()
                  .update(twoFactor)
                  .set({ [column]: next })
                  .where(and(eq(twoFactor.id, row.id), eq(twoFactor[column], old)))
                  .returning({ id: twoFactor.id })
              ).length,
          ),
        ),
      ),
    },
    {
      name: "owner_claims",
      key: "auth",
      rows: claims.map((row) =>
        sealedRow(
          row.value,
          async (next, old) =>
            (
              await db()
                .update(verification)
                .set({ value: next })
                .where(and(eq(verification.id, row.id), eq(verification.value, old)))
                .returning({ id: verification.id })
            ).length,
        ),
      ),
    },
  ];
}
async function inspect(key: KeyGroup["key"], value: string) {
  return key === "encryption" ? sealState(value) : authState(value);
}
async function protect(key: KeyGroup["key"], value: string) {
  return key === "encryption" ? sealSecret(unsealSecret(value)) : authReseal(value);
}
async function run(rewrite: boolean) {
  const result: KeyGroup[] = [];
  for (const group of await groups()) {
    const summary: KeyGroup = {
      name: group.name,
      key: group.key,
      total: group.rows.length,
      current: 0,
      previous: 0,
      unreadable: 0,
    };
    for (const row of group.rows) {
      const state = await inspect(group.key, row.value);
      if (state === "current") summary.current += 1;
      else if (state === "unreadable") summary.unreadable += 1;
      else if (rewrite) {
        // Rewritten on its own, and only when the value is still the one that was read.
        let rewritten: boolean;
        try {
          rewritten = await row.write(await protect(group.key, row.value));
        } catch {
          rewritten = false;
        }
        if (rewritten) summary.current += 1;
        else summary.previous += 1;
      } else summary.previous += 1;
    }
    result.push(summary);
  }
  return result;
}
// Nothing depends on the previous key any more. A value that no key opens does not: removing the key does not change it.
const settled = (result: KeyGroup[]) => result.every((group) => group.previous === 0);
// A run has something to do while a previous key is set or a value is still protected the older way (an authenticator that
// was stored before values carried the version of their secret is read with the current secret and is then re-protected).
export const hasWork = (result: KeyGroup[], previousSet: boolean) =>
  previousSet || !settled(result);
// What still depends on the previous key, without changing anything.
export async function keyStatus(principal: Principal) {
  owner(principal);
  const groupsNow = await run(false);
  return {
    encryptionPrevious: env().ENCRYPTION_KEY_PREVIOUS !== undefined,
    authPrevious: env().BETTER_AUTH_SECRET_PREVIOUS !== undefined,
    authVersion: env().BETTER_AUTH_SECRET_VERSION,
    groups: groupsNow,
    // Nothing depends on the previous key: it can be removed from the environment.
    settled: settled(groupsNow),
  };
}
// Re-protects every value that still depends on the previous key, one by one, and says what is left.
export async function rotateKeys(principal: Principal) {
  owner(principal);
  const previousSet =
    env().ENCRYPTION_KEY_PREVIOUS !== undefined || env().BETTER_AUTH_SECRET_PREVIOUS !== undefined;
  if (!hasWork(await run(false), previousSet)) throw new DomainError("conflict", 409);
  const groupsNow = await run(true);
  await db()
    .insert(audit)
    .values({
      projectId: null,
      actorId: principal.id,
      action: "keys.rotate",
      targetId: "workspace",
      detail: {
        groups: groupsNow.map(({ name, total, current, previous, unreadable }) => ({
          name,
          total,
          current,
          previous,
          unreadable,
        })),
        settled: settled(groupsNow),
      },
    });
  return {
    encryptionPrevious: env().ENCRYPTION_KEY_PREVIOUS !== undefined,
    authPrevious: env().BETTER_AUTH_SECRET_PREVIOUS !== undefined,
    authVersion: env().BETTER_AUTH_SECRET_VERSION,
    groups: groupsNow,
    settled: settled(groupsNow),
  };
}
export const keyGroupOut = z.object({
  name: z.string(),
  key: z.enum(["encryption", "auth"]),
  total: z.number(),
  current: z.number(),
  previous: z.number(),
  unreadable: z.number(),
});
export const keyStatusOut = z.object({
  encryptionPrevious: z.boolean(),
  authPrevious: z.boolean(),
  authVersion: z.number(),
  groups: z.array(keyGroupOut),
  settled: z.boolean(),
});
