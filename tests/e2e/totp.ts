import { createHmac } from "node:crypto";
// TOTP as Better Auth's two-factor plugin computes it: HMAC-SHA1 over the raw
// secret string, 6 digits, 30-second steps.
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", Buffer.from(secret, "utf8")).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
