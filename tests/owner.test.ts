import { lockOwners, unlockOwners } from "./support/owner-lock";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  hashPassword,
  symmetricDecrypt,
  symmetricEncrypt,
  verifyPassword,
} from "better-auth/crypto";
import { db, sqlClient } from "../src/server/db";
import { account, audit, session, twoFactor, user, verification } from "../src/server/db/schema";
import {
  confirmOwnerClaim,
  confirmOwnerRecovery,
  isDevelopmentOwner,
  passwordSignInAllowed,
  startOwnerClaim,
  startOwnerRecovery,
  totp,
} from "../src/server/owner";
import { env } from "../src/server/env";
import { authSecrets } from "../src/server/secrets";
import { auth } from "../src/server/auth";
const token = "test-owner-claim-token-not-a-real-credential";
// The token of the environment that the tests run in (the container of the stack has its own).
const recoveryToken = env().OWNER_RECOVERY_TOKEN ?? "";
const created: string[] = [];
function base32Decode(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes).toString("utf8");
}
async function removeOwners() {
  const owners = await db().select({ id: user.id }).from(user).where(eq(user.owner, true));
  const ids = [...owners.map((owner) => owner.id), ...created];
  if (ids.length) {
    await db().delete(audit).where(inArray(audit.actorId, ids));
    await db().delete(user).where(inArray(user.id, ids));
  }
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await lockOwners();
  await removeOwners();
});
afterAll(async () => {
  await removeOwners();
  await unlockOwners();
  await sqlClient().end();
});
describe("owner credentials", () => {
  it("computes TOTP like RFC 6238 with the raw secret as key", () => {
    expect(totp("12345678901234567890", 59_000)).toBe("287082");
    expect(totp("12345678901234567890", 1_111_111_109_000)).toBe("081804");
  });
  it("allows password sign-in only for active owners with TOTP", async () => {
    const plain = randomUUID();
    const owner = randomUUID();
    const enrolled = randomUUID();
    const disabled = randomUUID();
    created.push(plain, owner, enrolled, disabled);
    await db()
      .insert(user)
      .values([
        { id: plain, name: "Plain", email: `${plain}@example.test` },
        { id: owner, name: "No TOTP", email: `${owner}@example.test`, owner: true },
        {
          id: enrolled,
          name: "Enrolled",
          email: `${enrolled}@example.test`,
          owner: true,
          twoFactorEnabled: true,
        },
        {
          id: disabled,
          name: "Disabled",
          email: `${disabled}@example.test`,
          owner: true,
          twoFactorEnabled: true,
          active: false,
        },
      ]);
    expect(await passwordSignInAllowed("missing@example.test")).toBe(false);
    expect(await passwordSignInAllowed(`${plain}@example.test`)).toBe(false);
    expect(await passwordSignInAllowed(`${owner}@example.test`)).toBe(false);
    expect(await passwordSignInAllowed(` ${enrolled.toUpperCase()}@EXAMPLE.TEST `)).toBe(true);
    expect(await passwordSignInAllowed(`${disabled}@example.test`)).toBe(false);
    await db()
      .delete(user)
      .where(inArray(user.id, [plain, owner, enrolled, disabled]));
  });
  it("exempts only the generated development owner", () => {
    vi.stubEnv("DEV_BOOTSTRAP", "true");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_OWNER_EMAIL", "owner@aidesk.local");
    expect(isDevelopmentOwner("owner@aidesk.local")).toBe(true);
    expect(isDevelopmentOwner("other@aidesk.local")).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(isDevelopmentOwner("owner@aidesk.local")).toBe(false);
    vi.unstubAllEnvs();
  });
});
describe("first owner claim", () => {
  const input = {
    token,
    email: "First.Owner@Example.test",
    name: "First owner",
    password: "a long enough password",
  };
  it("rejects a wrong token and invalid input", async () => {
    await expect(startOwnerClaim({ ...input, token: "wrong" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(startOwnerClaim({ ...input, password: "short" })).rejects.toThrow();
  });
  it("creates exactly one owner with TOTP after a valid code", async () => {
    const first = await startOwnerClaim(input);
    const second = await startOwnerClaim({ ...input, email: "second@example.test" });
    expect(first.backupCodes).toHaveLength(10);
    expect(first.totpURI).toContain(`secret=${first.secret}`);
    const secret = base32Decode(first.secret);
    await expect(
      confirmOwnerClaim({ claimId: first.claimId, token: "wrong", code: totp(secret) }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      confirmOwnerClaim({ claimId: randomUUID(), token, code: totp(secret) }),
    ).rejects.toMatchObject({ code: "not_found" });
    const wrong = String((Number(totp(secret)) + 500_000) % 1_000_000).padStart(6, "0");
    await expect(
      confirmOwnerClaim({ claimId: first.claimId, token, code: wrong }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    const results = await Promise.allSettled([
      confirmOwnerClaim({ claimId: first.claimId, token, code: totp(secret) }),
      confirmOwnerClaim({
        claimId: second.claimId,
        token,
        code: totp(base32Decode(second.secret)),
      }),
    ]);
    const won = results.filter((result) => result.status === "fulfilled");
    expect(won).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "forbidden" },
    });
    const owners = await db().select().from(user).where(eq(user.owner, true));
    expect(owners).toHaveLength(1);
    const [owner] = owners;
    if (!owner) throw new Error("owner missing");
    created.push(owner.id);
    expect(owner).toMatchObject({ twoFactorEnabled: true, emailVerified: true, active: true });
    const [credential] = await db().select().from(account).where(eq(account.userId, owner.id));
    expect(credential?.providerId).toBe("credential");
    expect(credential?.password).not.toContain("a long enough password");
    const [factor] = await db().select().from(twoFactor).where(eq(twoFactor.userId, owner.id));
    const stored = await symmetricDecrypt({
      key: authSecrets().config,
      data: factor?.secret ?? "",
    });
    expect([base32Decode(first.secret), base32Decode(second.secret)]).toContain(stored);
    const [entry] = await db().select().from(audit).where(eq(audit.actorId, owner.id));
    expect(entry?.action).toBe("owner.claim");
    await expect(startOwnerClaim({ ...input, email: "late@example.test" })).rejects.toMatchObject({
      code: "forbidden",
    });
    // Recovery sign-in: password first, then TOTP; only the second step
    // creates a session, and it is audited.
    const password = await auth().api.signInEmail({
      body: { email: owner.email, password: input.password },
      asResponse: true,
    });
    expect(await password.json()).toMatchObject({ twoFactorRedirect: true });
    const challenge = password.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    expect(challenge).not.toMatch(/session_token=[^;]+/);
    const verified = await auth().api.verifyTOTP({
      body: { code: totp(stored) },
      headers: new Headers({ cookie: challenge }),
      asResponse: true,
    });
    expect(verified.status).toBe(200);
    expect(verified.headers.getSetCookie().join(";")).toMatch(/session_token=[^;]+/);
    const actions = (await db().select().from(audit).where(eq(audit.actorId, owner.id))).map(
      (row) => row.action,
    );
    expect(actions).toContain("owner.recovery_sign_in");
  });
  it("answers a non-owner password attempt like a wrong password", async () => {
    const id = randomUUID();
    created.push(id);
    await db()
      .insert(user)
      .values({ id, name: "Operator", email: `${id}@example.test`, emailVerified: true });
    // Over HTTP, as a client sees it.
    const attempt = (email: string, password: string) =>
      auth().handler(
        new Request("http://localhost:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({ email, password }),
        }),
      );
    const denied = await attempt(`${id}@example.test`, "whatever password");
    const [owner] = await db().select().from(user).where(eq(user.owner, true));
    const wrong = await attempt(owner?.email ?? "", "definitely the wrong password");
    expect(denied.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await denied.json()).toEqual(await wrong.json());
  });
});

describe("recovery of the owner password", () => {
  const email = `recovery-${randomUUID()}@example.test`;
  const oldPassword = "the old password of the owner";
  const newPassword = "a new password for the owner";
  const secret = "raw-secret-of-the-recovery-test";
  const backup = ["aaaaa-11111", "bbbbb-22222", "ccccc-33333"];
  let ownerId = "";
  const code = (value: string) => String((Number(value) + 500_000) % 1_000_000).padStart(6, "0");
  const start = (overrides: Record<string, string> = {}) =>
    startOwnerRecovery({ token: recoveryToken, email, password: newPassword, ...overrides });
  const confirm = (recoveryId: string, given: string, tokenGiven = recoveryToken) =>
    confirmOwnerRecovery({ recoveryId, token: tokenGiven, code: given });
  const passwordOf = async () => {
    const [row] = await db().select().from(account).where(eq(account.userId, ownerId));
    return row?.password ?? "";
  };
  const backupsOf = async (): Promise<string[]> => {
    const [row] = await db().select().from(twoFactor).where(eq(twoFactor.userId, ownerId));
    const plain = await symmetricDecrypt({
      key: authSecrets().config,
      data: row?.backupCodes ?? "",
    });
    return JSON.parse(plain) as string[];
  };
  beforeAll(async () => {
    await removeOwners();
  });
  beforeEach(async () => {
    await removeOwners();
    await db().delete(verification).where(like(verification.identifier, "owner-recovery-%"));
    ownerId = randomUUID();
    created.push(ownerId);
    await db().insert(user).values({
      id: ownerId,
      name: "Owner",
      email,
      emailVerified: true,
      owner: true,
      twoFactorEnabled: true,
    });
    await db()
      .insert(account)
      .values({
        id: randomUUID(),
        accountId: ownerId,
        providerId: "credential",
        userId: ownerId,
        password: await hashPassword(oldPassword),
      });
    await db()
      .insert(twoFactor)
      .values({
        id: randomUUID(),
        userId: ownerId,
        secret: await symmetricEncrypt({ key: authSecrets().config, data: secret }),
        backupCodes: await symmetricEncrypt({
          key: authSecrets().config,
          data: JSON.stringify(backup),
        }),
        verified: true,
      });
  });
  it("sets a new password with a code of the authenticator, ends the sessions, writes the audit and is used up", async () => {
    await db()
      .insert(session)
      .values({
        id: randomUUID(),
        token: randomUUID(),
        userId: ownerId,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    const { recoveryId } = await start();
    expect(await confirm(recoveryId, totp(secret))).toEqual({ recovered: true });
    expect(await verifyPassword({ hash: await passwordOf(), password: newPassword })).toBe(true);
    expect(await verifyPassword({ hash: await passwordOf(), password: oldPassword })).toBe(false);
    expect(await db().select().from(session).where(eq(session.userId, ownerId))).toHaveLength(0);
    const [entry] = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.actorId, ownerId), eq(audit.action, "owner.password_recovered")));
    expect(entry?.detail).toEqual({ method: "totp" });
    await expect(confirm(recoveryId, totp(secret))).rejects.toMatchObject({ code: "not_found" });
    // The sign-in with the new password reaches the second factor, the old one is refused.
    const signIn = (password: string) =>
      auth().api.signInEmail({ body: { email, password }, asResponse: true });
    expect(await (await signIn(newPassword)).json()).toMatchObject({ twoFactorRedirect: true });
    expect((await signIn(oldPassword)).status).toBe(401);
  });
  it("takes a backup code once and spends it", async () => {
    const first = await start();
    expect(await confirm(first.recoveryId, "bbbbb-22222")).toEqual({ recovered: true });
    expect(await backupsOf()).toEqual(["aaaaa-11111", "ccccc-33333"]);
    const second = await start();
    await expect(confirm(second.recoveryId, "bbbbb-22222")).rejects.toMatchObject({
      code: "invalid_input",
    });
    const [entry] = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.actorId, ownerId), eq(audit.action, "owner.password_recovered")));
    expect(entry?.detail).toEqual({ method: "backup_code" });
  });
  it("needs the recovery token in both steps, and not the claim token", async () => {
    await expect(start({ token: "wrong" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(start({ token })).rejects.toMatchObject({ code: "forbidden" });
    const { recoveryId } = await start();
    await expect(confirm(recoveryId, totp(secret), "wrong")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(confirm(recoveryId, totp(secret), token)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await verifyPassword({ hash: await passwordOf(), password: oldPassword })).toBe(true);
  });
  it("refuses a wrong code, and ends the recovery after five", async () => {
    const { recoveryId } = await start();
    for (let attempt = 0; attempt < 5; attempt += 1)
      await expect(confirm(recoveryId, code(totp(secret)))).rejects.toMatchObject({
        code: "invalid_input",
      });
    await expect(confirm(recoveryId, totp(secret))).rejects.toMatchObject({ code: "not_found" });
    expect(await verifyPassword({ hash: await passwordOf(), password: oldPassword })).toBe(true);
  });
  it("answers an address that is no owner like a wrong code, and changes nothing", async () => {
    const other = randomUUID();
    created.push(other);
    await db()
      .insert(user)
      .values({ id: other, name: "Operator", email: `${other}@example.test`, emailVerified: true });
    for (const address of [`${other}@example.test`, `nobody-${other}@example.test`]) {
      const started = await start({ email: address });
      expect(Object.keys(started)).toEqual(["recoveryId"]);
      await expect(confirm(started.recoveryId, totp(secret))).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(await verifyPassword({ hash: await passwordOf(), password: oldPassword })).toBe(true);
  });
  it("does not recover an operator who has a second factor but is no owner, nor an owner whose second factor is off", async () => {
    const other = randomUUID();
    created.push(other);
    const otherEmail = `${other}@example.test`;
    await db().insert(user).values({
      id: other,
      name: "Operator",
      email: otherEmail,
      emailVerified: true,
      twoFactorEnabled: true,
    });
    await db()
      .insert(account)
      .values({
        id: randomUUID(),
        accountId: other,
        providerId: "credential",
        userId: other,
        password: await hashPassword(oldPassword),
      });
    await db()
      .insert(twoFactor)
      .values({
        id: randomUUID(),
        userId: other,
        secret: await symmetricEncrypt({ key: authSecrets().config, data: secret }),
        backupCodes: await symmetricEncrypt({ key: authSecrets().config, data: "[]" }),
      });
    const started = await start({ email: otherEmail });
    await expect(confirm(started.recoveryId, totp(secret))).rejects.toMatchObject({
      code: "invalid_input",
    });
    await db().update(user).set({ twoFactorEnabled: false }).where(eq(user.id, ownerId));
    const own = await start();
    await expect(confirm(own.recoveryId, totp(secret))).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(await verifyPassword({ hash: await passwordOf(), password: oldPassword })).toBe(true);
  });
  it("needs a password of twelve characters, a valid address and a well-formed code", async () => {
    await expect(start({ password: "short" })).rejects.toThrow();
    await expect(start({ email: "not an address" })).rejects.toThrow();
    const { recoveryId } = await start();
    await expect(confirm(recoveryId, "12345")).rejects.toThrow();
    await expect(confirm("not-an-id", totp(secret))).rejects.toThrow();
  });
  it("lets only a few recoveries start in an hour", async () => {
    for (let count = 0; count < 10; count += 1) await start();
    await expect(start()).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("is not there without a recovery token in the environment", async () => {
    vi.stubEnv("OWNER_RECOVERY_TOKEN", "");
    vi.resetModules();
    const fresh = await import("../src/server/owner");
    await expect(
      fresh.startOwnerRecovery({ token: recoveryToken, email, password: newPassword }),
    ).rejects.toMatchObject({ code: "forbidden" });
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
