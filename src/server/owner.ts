import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { hashPassword, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { z } from "zod";
import { db } from "./db";
import { account, audit, twoFactor, user, verification } from "./db/schema";
import { DomainError } from "./errors";
import { env } from "./env";
// Owners are the only operators with a local credential: password plus TOTP.
// It is the recovery path when the identity provider is unavailable. Every
// other operator signs in through SSO.
export function isDevelopmentOwner(email: string): boolean {
  return (
    process.env.DEV_BOOTSTRAP === "true" &&
    process.env.NODE_ENV === "development" &&
    email === process.env.DEV_OWNER_EMAIL?.toLowerCase()
  );
}
export async function passwordSignInAllowed(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const [candidate] = await db()
    .select({ active: user.active, owner: user.owner, twoFactorEnabled: user.twoFactorEnabled })
    .from(user)
    .where(eq(user.email, normalized))
    .limit(1);
  if (!candidate?.active || !candidate.owner) return false;
  return candidate.twoFactorEnabled || isDevelopmentOwner(normalized);
}
// TOTP as Better Auth's two-factor plugin computes it: HMAC-SHA1 over the raw
// secret string, 6 digits, 30-second steps.
export function totp(secret: string, at = Date.now(), step = 0): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000) + step));
  const digest = createHmac("sha1", Buffer.from(secret, "utf8")).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, "0");
}
function totpMatches(secret: string, code: string, at = Date.now()): boolean {
  return [-1, 0, 1].some((step) => {
    const expected = Buffer.from(totp(secret, at, step));
    const given = Buffer.from(code);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}
function base32(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of Buffer.from(value, "utf8")) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let index = 0; index < bits.length; index += 5)
    out += alphabet.charAt(Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2));
  return out;
}
function claimTokenMatches(given: string): boolean {
  const configured = env().OWNER_CLAIM_TOKEN;
  if (!configured) return false;
  const expected = createHash("sha256").update(configured).digest();
  return timingSafeEqual(expected, createHash("sha256").update(given).digest());
}
async function ownerExists(): Promise<boolean> {
  const [existing] = await db()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.owner, true))
    .limit(1);
  return Boolean(existing);
}
const startInput = z.object({
  token: z.string().min(1).max(512),
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(128),
});
const pendingSchema = z.object({
  email: z.string(),
  name: z.string(),
  passwordHash: z.string(),
  secret: z.string(),
  backupCodes: z.array(z.string()),
});
// Step one validates the claim and prepares TOTP enrolment. Nothing is
// created yet; the pending claim lives ten minutes in the verification table,
// encrypted with the auth secret.
export async function startOwnerClaim(input: unknown) {
  const values = startInput.parse(input);
  if (!claimTokenMatches(values.token) || (await ownerExists()))
    throw new DomainError("forbidden", 403);
  const email = values.email.toLowerCase();
  const secret = randomBytes(24).toString("base64url");
  const backupCodes = Array.from({ length: 10 }, () => {
    const raw = randomBytes(5).toString("hex");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  const claimId = randomUUID();
  const pending = {
    email,
    name: values.name,
    passwordHash: await hashPassword(values.password),
    secret,
    backupCodes,
  };
  await db()
    .insert(verification)
    .values({
      id: randomUUID(),
      identifier: `owner-claim-${claimId}`,
      value: await symmetricEncrypt({
        key: env().BETTER_AUTH_SECRET,
        data: JSON.stringify(pending),
      }),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  const label = encodeURIComponent(`aidesk:${email}`);
  return {
    claimId,
    totpURI: `otpauth://totp/${label}?secret=${base32(secret)}&issuer=aidesk&digits=6&period=30`,
    secret: base32(secret),
    backupCodes,
  };
}
const confirmInput = z.object({
  claimId: z.uuid(),
  token: z.string().min(1).max(512),
  code: z.string().regex(/^\d{6}$/),
});
// Step two creates the owner with TOTP already enabled, so an owner never
// exists without a second factor. An advisory lock serialises concurrent
// claims; the first one wins.
export async function confirmOwnerClaim(input: unknown) {
  const values = confirmInput.parse(input);
  if (!claimTokenMatches(values.token)) throw new DomainError("forbidden", 403);
  const identifier = `owner-claim-${values.claimId}`;
  const [row] = await db()
    .select()
    .from(verification)
    .where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, new Date())))
    .limit(1);
  if (!row) throw new DomainError("not_found", 404);
  const pending = pendingSchema.parse(
    JSON.parse(await symmetricDecrypt({ key: env().BETTER_AUTH_SECRET, data: row.value })),
  );
  if (!totpMatches(pending.secret, values.code)) throw new DomainError("invalid_input", 400);
  const id = randomUUID();
  await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('aidesk-owner-claim'))`);
    const [owner] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.owner, true))
      .limit(1);
    if (owner) throw new DomainError("forbidden", 403);
    const deleted = await tx
      .delete(verification)
      .where(eq(verification.identifier, identifier))
      .returning({ id: verification.id });
    if (deleted.length === 0) throw new DomainError("not_found", 404);
    await tx.insert(user).values({
      id,
      name: pending.name,
      email: pending.email,
      emailVerified: true,
      owner: true,
      twoFactorEnabled: true,
    });
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: pending.passwordHash,
    });
    await tx.insert(twoFactor).values({
      id: randomUUID(),
      userId: id,
      secret: await symmetricEncrypt({ key: env().BETTER_AUTH_SECRET, data: pending.secret }),
      backupCodes: await symmetricEncrypt({
        key: env().BETTER_AUTH_SECRET,
        data: JSON.stringify(pending.backupCodes),
      }),
      verified: true,
    });
    await tx.insert(audit).values({ actorId: id, action: "owner.claim", targetId: id });
  });
  return { id, email: pending.email };
}
