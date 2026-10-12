import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { symmetricDecrypt } from "better-auth/crypto";
import { db, sqlClient } from "../src/server/db";
import { account, audit, twoFactor, user } from "../src/server/db/schema";
import {
  confirmOwnerClaim,
  isDevelopmentOwner,
  passwordSignInAllowed,
  startOwnerClaim,
  totp,
} from "../src/server/owner";
import { env } from "../src/server/env";
import { auth } from "../src/server/auth";
const token = "test-owner-claim-token-not-a-real-credential";
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
  await removeOwners();
});
afterAll(async () => {
  await removeOwners();
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
      key: env().BETTER_AUTH_SECRET,
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
