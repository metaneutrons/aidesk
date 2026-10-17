import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { hashPassword, symmetricEncrypt } from "better-auth/crypto";
import { db, sqlClient } from "../src/server/db";
import {
  account,
  audit,
  passkey,
  session,
  twoFactor,
  user,
  verification,
} from "../src/server/db/schema";
import { auth } from "../src/server/auth";
import { env } from "../src/server/env";
import { totp } from "../src/server/owner";
import { assertion, softPasskey, type SoftPasskey } from "./support/webauthn";
// A passkey is the second factor after the password: it confirms the pending step of that user, with
// the user verified by the device, and it never signs anybody in alone.
const origin = new URL(env().APP_URL);
const base = origin.origin;
const rpId = origin.hostname;
const password = "the password of the owner";
const secret = "raw-secret-of-the-passkey-test";
const ids: string[] = [];
let ownerId = "";
let ownerEmail = "";
let ownerKey: SoftPasskey;
async function makeOwner(owner: boolean) {
  const id = randomUUID();
  ids.push(id);
  const email = `passkey-${id}@example.test`;
  await db()
    .insert(user)
    .values({ id, name: "Owner", email, emailVerified: true, owner, twoFactorEnabled: true });
  await db()
    .insert(account)
    .values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: await hashPassword(password),
    });
  await db()
    .insert(twoFactor)
    .values({
      id: randomUUID(),
      userId: id,
      secret: await symmetricEncrypt({ key: env().BETTER_AUTH_SECRET, data: secret }),
      backupCodes: await symmetricEncrypt({ key: env().BETTER_AUTH_SECRET, data: "[]" }),
      verified: true,
    });
  return { id, email };
}
async function addPasskey(userId: string): Promise<SoftPasskey> {
  const key = softPasskey();
  await db().insert(passkey).values({
    id: randomUUID(),
    userId,
    credentialID: key.credentialId,
    publicKey: key.publicKey,
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
  });
  return key;
}
// Requests with the cookies that the answers set, as a browser would keep them.
function client(initial?: Map<string, string>) {
  const jar = new Map<string, string>(initial);
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await auth().handler(
      new Request(`${base}/api/auth${path}`, {
        method: init.method ?? "GET",
        headers: {
          "content-type": "application/json",
          origin: base,
          cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair?.indexOf("=") ?? -1;
      if (!pair || at < 0) continue;
      const value = pair.slice(at + 1);
      if (value === "" || /max-age=0/i.test(line)) jar.delete(pair.slice(0, at));
      else jar.set(pair.slice(0, at), value);
    }
    return response;
  };
  return { call, jar };
}
const passwordStep = (c: ReturnType<typeof client>, email = ownerEmail) =>
  c.call("/sign-in/email", { method: "POST", body: { email, password } });
async function challengeOf(c: ReturnType<typeof client>): Promise<string> {
  const response = await c.call("/passkey/generate-authenticate-options");
  expect(response.status).toBe(200);
  return ((await response.json()) as { challenge: string }).challenge;
}
const sign = (key: SoftPasskey, challenge: string, overrides = {}) =>
  assertion(key, { challenge, rpId, origin: base, counter: 1, verified: true, ...overrides });
const hasSession = (c: ReturnType<typeof client>) =>
  [...c.jar.keys()].some((name) => name.includes("session_token"));
const pendingSteps = () =>
  db().select().from(verification).where(like(verification.identifier, "2fa-%"));
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  if (ids.length) {
    await db().delete(audit).where(inArray(audit.actorId, ids));
    await db().delete(user).where(inArray(user.id, ids));
  }
  await sqlClient().end();
});
beforeEach(async () => {
  const owner = await makeOwner(true);
  ownerId = owner.id;
  ownerEmail = owner.email;
  ownerKey = await addPasskey(ownerId);
});
describe("a passkey as the second factor", () => {
  it("signs the owner in after the password, writes the audit and uses the step up", async () => {
    const c = client();
    expect((await (await passwordStep(c)).json()) as unknown).toMatchObject({
      twoFactorRedirect: true,
    });
    expect(hasSession(c)).toBe(false);
    const status = await c.call("/owner-passkey/status");
    expect(await status.json()).toEqual({ passkey: true });
    // What a thief of the cookie of the pending step would hold.
    const challenge = await challengeOf(c);
    const stolen = new Map([...c.jar].filter(([name]) => name.includes("two_factor")));
    expect(stolen.size).toBe(1);
    const verified = await c.call("/passkey/verify-authentication", {
      method: "POST",
      body: { response: sign(ownerKey, challenge) },
    });
    expect(verified.status).toBe(200);
    expect(hasSession(c)).toBe(true);
    const replay = client(stolen);
    expect((await replay.call("/owner-passkey/status")).status).toBe(401);
    expect(
      (
        await replay.call("/two-factor/verify-totp", {
          method: "POST",
          body: { code: totp(secret) },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(hasSession(replay)).toBe(false);
    const [entry] = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.actorId, ownerId), eq(audit.action, "owner.recovery_sign_in")));
    expect(entry?.detail).toEqual({ method: "passkey" });
    // The step of the password is gone: no second assertion, and no new options.
    expect((await c.call("/owner-passkey/status")).status).toBe(401);
    expect((await c.call("/passkey/generate-authenticate-options")).status).toBe(401);
  });
  it("does not sign anybody in without the password step", async () => {
    const c = client();
    expect((await c.call("/passkey/generate-authenticate-options")).status).toBe(401);
    expect((await c.call("/owner-passkey/status")).status).toBe(401);
    const loose = await c.call("/passkey/verify-authentication", {
      method: "POST",
      body: { response: sign(ownerKey, "x") },
    });
    expect(loose.status).toBeGreaterThanOrEqual(400);
    expect(hasSession(c)).toBe(false);
  });
  it("refuses a passkey of another user, also when the assertion is valid, and keeps the step", async () => {
    const other = await makeOwner(true);
    const otherKey = await addPasskey(other.id);
    const c = client();
    await passwordStep(c);
    const refused = await c.call("/passkey/verify-authentication", {
      method: "POST",
      body: { response: sign(otherKey, await challengeOf(c)) },
    });
    expect(refused.status).toBe(401);
    expect(hasSession(c)).toBe(false);
    expect(await db().select().from(session).where(eq(session.userId, other.id))).toHaveLength(0);
    // The step of the password is still there, so the right passkey works afterwards.
    const accepted = await c.call("/passkey/verify-authentication", {
      method: "POST",
      body: { response: sign(ownerKey, await challengeOf(c)) },
    });
    expect(accepted.status).toBe(200);
  });
  it("refuses an assertion without user verification", async () => {
    const c = client();
    await passwordStep(c);
    const refused = await c.call("/passkey/verify-authentication", {
      method: "POST",
      body: { response: sign(ownerKey, await challengeOf(c), { verified: false }) },
    });
    expect(refused.status).toBe(401);
    expect(hasSession(c)).toBe(false);
  });
  it("refuses a wrong signature and a replayed challenge", async () => {
    const c = client();
    await passwordStep(c);
    const challenge = await challengeOf(c);
    const forged = sign(softPasskey(), challenge);
    forged.id = ownerKey.credentialId;
    forged.rawId = ownerKey.credentialId;
    expect(
      (
        await c.call("/passkey/verify-authentication", {
          method: "POST",
          body: { response: forged },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(hasSession(c)).toBe(false);
    // A challenge is used once: the same assertion again finds none.
    const good = sign(ownerKey, await challengeOf(c));
    expect(
      (await c.call("/passkey/verify-authentication", { method: "POST", body: { response: good } }))
        .status,
    ).toBe(200);
    const again = client();
    await passwordStep(again);
    await challengeOf(again);
    expect(
      (
        await again.call("/passkey/verify-authentication", {
          method: "POST",
          body: { response: good },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(hasSession(again)).toBe(false);
  });
  it("tells the sign-in page whether the owner has a passkey, and the code keeps working without one", async () => {
    const plain = await makeOwner(true);
    const c = client();
    await passwordStep(c, plain.email);
    expect(await (await c.call("/owner-passkey/status")).json()).toEqual({ passkey: false });
    const verified = await c.call("/two-factor/verify-totp", {
      method: "POST",
      body: { code: totp(secret) },
    });
    expect(verified.status).toBe(200);
    expect(hasSession(c)).toBe(true);
    // The code also works for an owner who has a passkey.
    const withKey = client();
    await passwordStep(withKey);
    expect(
      (
        await withKey.call("/two-factor/verify-totp", {
          method: "POST",
          body: { code: totp(secret) },
        })
      ).status,
    ).toBe(200);
  });
  it("registers passkeys for owners only", async () => {
    const c = client();
    await passwordStep(c);
    await c.call("/two-factor/verify-totp", { method: "POST", body: { code: totp(secret) } });
    expect(hasSession(c)).toBe(true);
    expect((await c.call("/passkey/generate-register-options")).status).toBe(200);
    // The same session, after the user is no owner any more.
    await db().update(user).set({ owner: false }).where(eq(user.id, ownerId));
    expect((await c.call("/passkey/generate-register-options")).status).toBe(403);
    const attempt = await c.call("/passkey/verify-registration", {
      method: "POST",
      body: { response: {} },
    });
    expect([400, 403]).toContain(attempt.status);
    expect(attempt.status).not.toBe(200);
    // Nobody without a session asks for options.
    expect((await client().call("/passkey/generate-register-options")).status).toBe(401);
  });
  it("leaves no step behind that another sign-in could use", async () => {
    const before = (await pendingSteps()).length;
    const c = client();
    await passwordStep(c);
    await c.call("/passkey/verify-authentication", {
      method: "POST",
      body: { response: sign(ownerKey, await challengeOf(c)) },
    });
    const left = (await pendingSteps()).filter((row) => row.value === ownerId);
    expect(left.length).toBeLessThanOrEqual(before);
  });
});
