import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  configChanges,
  connections,
  projects,
  tickets,
  twoFactor,
  user,
  verification,
  webhooks,
} from "../src/server/db/schema";
import { seal, unseal } from "../src/server/crypto";
import { lockOwners, unlockOwners } from "./support/owner-lock";
import { env, resetEnv } from "../src/server/env";
import { hasWork, keyStatus, rotateKeys } from "../src/server/key-rotation";
import { issuePortalGrant, resolvePortalGrant } from "../src/server/portal";
import { authSecrets, sealSecret, sealState, unsealSecret } from "../src/server/secrets";
import type { Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectId = randomUUID();
const ownerId = `keys-owner-${run}`;
const ownerPrincipal: Principal = {
  id: ownerId,
  kind: "human",
  active: true,
  owner: true,
  grants: [],
};
const plainPerson: Principal = { ...ownerPrincipal, id: `keys-person-${run}`, owner: false };
const staff: Principal = {
  ...plainPerson,
  grants: [{ projectId, actions: ["project.read", "ticket.read", "ticket.reply"] }],
};
const oldKey = "cd".repeat(32);
const thirdKey = "ef".repeat(32);
const oldSecret = `old-secret-${run}-`.padEnd(40, "o");
const names = [
  "ENCRYPTION_KEY",
  "ENCRYPTION_KEY_PREVIOUS",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_SECRET_PREVIOUS",
  "BETTER_AUTH_SECRET_VERSION",
] as const;
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
// Reads the keys again, as after a restart with another environment.
function useKeys(values: Partial<Record<(typeof names)[number], string | undefined>>) {
  for (const name of names) {
    const value = name in values ? values[name] : original[name];
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  resetEnv();
}
afterEach(() => {
  useKeys({});
});
const currentKey = () => original.ENCRYPTION_KEY ?? "";
const group = async (name: string) =>
  (await keyStatus(ownerPrincipal)).groups.find((entry) => entry.name === name);
beforeAll(async () => {
  await lockOwners();
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values({ id: projectId, name: "Keys", slug: `keys-${run}` });
  await db()
    .insert(user)
    .values({
      id: ownerId,
      name: "Owner",
      email: `${ownerId}@example.test`,
      emailVerified: true,
      owner: true,
    });
});
afterAll(async () => {
  useKeys({});
  await db().delete(configChanges).where(eq(configChanges.projectId, projectId));
  await db().delete(connections).where(eq(connections.projectId, projectId));
  await db().delete(webhooks).where(eq(webhooks.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(audit).where(eq(audit.actorId, ownerId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db()
    .delete(verification)
    .where(sql`${verification.identifier} like ${`owner-claim-keys-${run}%`}`);
  await db().delete(twoFactor).where(eq(twoFactor.userId, ownerId));
  await db().execute(sql`delete from sso_provider where provider_id like ${`keys-${run}%`}`);
  await db().delete(projects).where(eq(projects.id, projectId));
  await db().delete(user).where(eq(user.id, ownerId));
  await unlockOwners();
  await sqlClient().end();
});
describe("the two keys", () => {
  it("seals with the current key and reads with the previous one while it is set", () => {
    const sealed = seal("secret", oldKey);
    expect(() => unsealSecret(sealed)).toThrow();
    expect(sealState(sealed)).toBe("unreadable");
    useKeys({ ENCRYPTION_KEY_PREVIOUS: oldKey });
    expect(unsealSecret(sealed)).toBe("secret");
    expect(sealState(sealed)).toBe("previous");
    expect(sealState(sealSecret("again"))).toBe("current");
    expect(unseal(sealSecret("again"), currentKey())).toBe("again");
    expect(sealState(seal("x", thirdKey))).toBe("unreadable");
  });
  it("numbers the secrets and keeps the oldest as the one for values without a version", () => {
    expect(authSecrets().secrets).toHaveLength(1);
    expect(authSecrets().config.currentVersion).toBe(1);
    useKeys({ BETTER_AUTH_SECRET_PREVIOUS: oldSecret, BETTER_AUTH_SECRET_VERSION: "5" });
    const { secrets, config, legacy } = authSecrets();
    expect(secrets.map((entry) => entry.version)).toEqual([5, 4]);
    expect(secrets[1]?.value).toBe(oldSecret);
    expect(legacy).toBe(oldSecret);
    expect(config.keys.get(4)).toBe(oldSecret);
    expect(env().BETTER_AUTH_SECRET_VERSION).toBe(5);
  });
});
describe("rotating the encryption key", () => {
  it("re-seals every stored secret that depends on the previous key, one by one, and leaves what no key opens", async () => {
    useKeys({ ENCRYPTION_KEY_PREVIOUS: oldKey });
    // Other test files of the same database add and remove secrets of their own while this one runs, so the counts of the
    // stored values are read as what is at least there (the values of this test cannot be removed by another file).
    const count = async (name: string, field: "total" | "current" | "previous" | "unreadable") =>
      (await group(name))?.[field] ?? 0;
    const mine = randomUUID();
    const other = randomUUID();
    const already = randomUUID();
    const proposal = randomUUID();
    await db()
      .insert(connections)
      .values([
        {
          id: mine,
          projectId,
          kind: "smtp",
          direction: "outbound",
          name: "Old",
          config: {},
          secretCiphertext: seal('{"pass":"old"}', oldKey),
        },
        {
          id: already,
          projectId,
          kind: "smtp",
          direction: "outbound",
          name: "New",
          config: {},
          secretCiphertext: seal('{"pass":"new"}', currentKey()),
        },
        {
          id: other,
          projectId,
          kind: "smtp",
          direction: "outbound",
          name: "Lost",
          config: {},
          secretCiphertext: seal('{"pass":"lost"}', thirdKey),
        },
      ]);
    const [hook] = await db()
      .insert(webhooks)
      .values({
        projectId,
        name: "Hook",
        url: "https://hooks.example.test/in",
        events: ["ticket.created"],
        secretCiphertext: seal("hook-secret-0123456789", oldKey),
      })
      .returning({ id: webhooks.id });
    await db().execute(
      sql`insert into sso_provider (id, issuer, oidc_config, saml_config, provider_id, domain) values (${`keys-${run}`}, 'https://issuer.example.test', ${seal("oidc", oldKey)}, ${seal("saml", oldKey)}, ${`keys-${run}`}, 'example.test')`,
    );
    await db()
      .insert(configChanges)
      .values({
        id: proposal,
        projectId,
        kind: "connection.create",
        target: null,
        baseVersion: 0,
        status: "pending",
        proposedBy: "agent",
        proposerKind: "agent",
        payload: { secret: seal('{"pass":"proposed"}', oldKey) },
        diff: [],
      });
    // A proposal that was decided is no longer read; its secret is left as it is.
    const decided = randomUUID();
    await db()
      .insert(configChanges)
      .values({
        id: decided,
        projectId,
        kind: "connection.create",
        target: null,
        baseVersion: 0,
        status: "applied",
        proposedBy: "agent",
        proposerKind: "agent",
        payload: { secret: seal('{"pass":"decided"}', oldKey) },
        diff: [],
      });
    const before = await keyStatus(ownerPrincipal);
    expect(before.encryptionPrevious).toBe(true);
    expect(before.settled).toBe(false);
    expect(await count("connections", "total")).toBeGreaterThanOrEqual(3);
    expect(await count("connections", "current")).toBeGreaterThanOrEqual(1);
    expect(await count("connections", "previous")).toBeGreaterThanOrEqual(1);
    expect(await count("connections", "unreadable")).toBeGreaterThanOrEqual(1);
    expect(await count("webhooks", "previous")).toBeGreaterThanOrEqual(1);
    expect(await count("sso", "previous")).toBeGreaterThanOrEqual(2);
    expect(await count("proposals", "previous")).toBeGreaterThanOrEqual(1);
    const after = await rotateKeys(ownerPrincipal);
    // The value that no key opens does not keep the previous key in use.
    expect(after.settled).toBe(true);
    for (const name of ["connections", "webhooks", "sso", "proposals"])
      expect((await group(name))?.previous).toBe(0);
    expect(await count("connections", "current")).toBeGreaterThanOrEqual(2);
    expect(await count("connections", "unreadable")).toBeGreaterThanOrEqual(1);
    // The previous key can go: everything that was readable is readable with the current key alone.
    useKeys({});
    const [rotated] = await db().select().from(connections).where(eq(connections.id, mine));
    expect(unseal(rotated?.secretCiphertext ?? "", currentKey())).toBe('{"pass":"old"}');
    const [lost] = await db().select().from(connections).where(eq(connections.id, other));
    expect(unseal(lost?.secretCiphertext ?? "", thirdKey)).toBe('{"pass":"lost"}');
    const [hooked] = await db()
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, hook?.id ?? ""));
    expect(unseal(hooked?.secretCiphertext ?? "", currentKey())).toBe("hook-secret-0123456789");
    const [changed] = await db().select().from(configChanges).where(eq(configChanges.id, proposal));
    expect(unseal(String(changed?.payload.secret), currentKey())).toBe('{"pass":"proposed"}');
    const [left] = await db().select().from(configChanges).where(eq(configChanges.id, decided));
    expect(unseal(String(left?.payload.secret), oldKey)).toBe('{"pass":"decided"}');
    // Single sign-on reads through its column, which unseals with the current key.
    const sso = await db().execute<{ oidc: string }>(
      sql`select oidc_config as oidc from sso_provider where provider_id = ${`keys-${run}`}`,
    );
    expect(unseal([...sso][0]?.oidc ?? "", currentKey())).toBe("oidc");
    await db().delete(connections).where(eq(connections.id, other));
  });
  it("can be run again and then has nothing left to do, and is an entry of the audit without any secret", async () => {
    await db()
      .insert(connections)
      .values({
        projectId,
        kind: "smtp",
        direction: "outbound",
        name: "Old again",
        config: {},
        secretCiphertext: seal('{"pass":"again-old"}', oldKey),
      });
    useKeys({ ENCRYPTION_KEY_PREVIOUS: oldKey });
    await db().delete(audit).where(eq(audit.actorId, ownerId));
    const first = await rotateKeys(ownerPrincipal);
    expect(first.groups.find((entry) => entry.name === "connections")?.previous).toBe(0);
    const second = await rotateKeys(ownerPrincipal);
    expect(second.groups.every((entry) => entry.previous === 0)).toBe(true);
    const entries = (await db().select().from(audit).where(eq(audit.actorId, ownerId))).filter(
      (entry) => entry.action === "keys.rotate",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ projectId: null, detail: { settled: expect.any(Boolean) } });
    expect(JSON.stringify(entries)).not.toContain("again-old");
    expect(JSON.stringify(entries)).not.toContain(oldKey);
    expect(JSON.stringify(entries)).not.toContain(currentKey());
  });
});
describe("rotating the secret of the sign-in", () => {
  it("re-protects the authenticator, the backup codes and the claims of an owner with the current secret and its version", async () => {
    const claim = `owner-claim-keys-${run}`;
    await db()
      .insert(twoFactor)
      .values({
        id: randomUUID(),
        userId: ownerId,
        secret: await symmetricEncrypt({ key: oldSecret, data: "JBSWY3DPEHPK3PXP" }),
        backupCodes: await symmetricEncrypt({ key: oldSecret, data: '["a1","b2"]' }),
      });
    await db()
      .insert(verification)
      .values({
        id: randomUUID(),
        identifier: claim,
        value: await symmetricEncrypt({ key: oldSecret, data: "pending" }),
        expiresAt: new Date(Date.now() + 600_000),
      });
    useKeys({ BETTER_AUTH_SECRET_PREVIOUS: oldSecret, BETTER_AUTH_SECRET_VERSION: "2" });
    // Other tests of the same database may have owners of their own, so the numbers are taken as differences.
    const factors = await group("owner_factors");
    const claims = await group("owner_claims");
    expect(factors?.previous).toBeGreaterThanOrEqual(2);
    expect(claims?.previous).toBeGreaterThanOrEqual(1);
    await rotateKeys(ownerPrincipal);
    const factorsAfter = await group("owner_factors");
    const claimsAfter = await group("owner_claims");
    expect(factorsAfter?.previous).toBe(0);
    expect(claimsAfter?.previous).toBe(0);
    expect((factorsAfter?.current ?? 0) - (factors?.current ?? 0)).toBeGreaterThanOrEqual(2);
    expect((claimsAfter?.current ?? 0) - (claims?.current ?? 0)).toBeGreaterThanOrEqual(1);
    // Without the previous secret the values are read with the current one, and carry its version.
    useKeys({ BETTER_AUTH_SECRET_VERSION: "2" });
    const [factor] = await db().select().from(twoFactor).where(eq(twoFactor.userId, ownerId));
    expect(factor?.secret.startsWith("$ba$2$")).toBe(true);
    expect(await symmetricDecrypt({ key: authSecrets().config, data: factor?.secret ?? "" })).toBe(
      "JBSWY3DPEHPK3PXP",
    );
    expect(
      await symmetricDecrypt({ key: authSecrets().config, data: factor?.backupCodes ?? "" }),
    ).toBe('["a1","b2"]');
    const [pending] = await db()
      .select()
      .from(verification)
      .where(eq(verification.identifier, claim));
    expect(await symmetricDecrypt({ key: authSecrets().config, data: pending?.value ?? "" })).toBe(
      "pending",
    );
    // A value of a version that was retired is left as it is.
    await db()
      .update(verification)
      .set({ value: "$ba$9$00" })
      .where(eq(verification.identifier, claim));
    expect((await group("owner_claims"))?.unreadable).toBe((claimsAfter?.unreadable ?? 0) + 1);
  });
});
describe("links of the customer page", () => {
  it("stay valid under the previous key while it is kept, and end when it is removed", async () => {
    useKeys({ ENCRYPTION_KEY: oldKey });
    const [made] = await db()
      .insert(tickets)
      .values({
        projectId,
        subject: "Portal",
        requesterEmail: "alex@example.test",
        requesterName: "Alex",
        language: "en",
      })
      .returning({ id: tickets.id });
    const { token } = await issuePortalGrant(staff, made?.id ?? "");
    expect(await resolvePortalGrant(token)).not.toBeNull();
    useKeys({ ENCRYPTION_KEY: currentKey(), ENCRYPTION_KEY_PREVIOUS: oldKey });
    expect(await resolvePortalGrant(token)).not.toBeNull();
    const fresh = await issuePortalGrant(staff, made?.id ?? "");
    expect(await resolvePortalGrant(fresh.token)).not.toBeNull();
    expect(fresh.token).not.toBe(token);
    useKeys({ ENCRYPTION_KEY: currentKey() });
    expect(await resolvePortalGrant(token)).toBeNull();
    expect(await resolvePortalGrant(fresh.token)).not.toBeNull();
  });
});
describe("who may rotate", () => {
  const group = (previous: number, unreadable = 0) => [
    {
      name: "connections",
      key: "encryption" as const,
      total: previous + unreadable,
      current: 0,
      previous,
      unreadable,
    },
  ];
  it("has work while a previous key is set or a value still depends on one, and not otherwise", () => {
    expect(hasWork(group(0), false)).toBe(false);
    expect(hasWork(group(0, 3), false)).toBe(false);
    expect(hasWork(group(0), true)).toBe(true);
    expect(hasWork(group(2), false)).toBe(true);
  });
  it("is the owner", async () => {
    for (const who of [
      plainPerson,
      staff,
      { ...ownerPrincipal, kind: "agent" as const },
      { ...ownerPrincipal, active: false },
    ]) {
      await expect(keyStatus(who)).rejects.toMatchObject({ code: "forbidden" });
      await expect(rotateKeys(who)).rejects.toMatchObject({ code: "forbidden" });
    }
    useKeys({});
    const status = await keyStatus(ownerPrincipal);
    expect(status).toMatchObject({ encryptionPrevious: false, authPrevious: false });
    // Without a previous key a run is refused when no value is left to re-protect.
    if (status.settled)
      await expect(rotateKeys(ownerPrincipal)).rejects.toMatchObject({
        code: "conflict",
        status: 409,
      });
    else expect((await rotateKeys(ownerPrincipal)).settled).toBe(true);
  });
});
