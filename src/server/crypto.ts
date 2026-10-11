import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export function seal(value: string, keyHex: string): string {
  if (!/^[a-f0-9]{64}$/.test(keyHex)) throw new Error("invalid_encryption_key");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    payload.toString("hex"),
  ].join(":");
}
export function unseal(value: string, keyHex: string): string {
  if (!/^[a-f0-9]{64}$/.test(keyHex)) throw new Error("invalid_encryption_key");
  const [version, nonce, tag, payload, extra] = value.split(":");
  if (
    version !== "v1" ||
    !nonce ||
    !tag ||
    payload === undefined ||
    extra !== undefined ||
    !/^[a-f0-9]{24}$/.test(nonce) ||
    !/^[a-f0-9]{32}$/.test(tag) ||
    !/^(?:[a-f0-9]{2})*$/.test(payload)
  )
    throw new Error("invalid_encrypted_value");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    Buffer.from(nonce, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(payload, "hex")), decipher.final()]).toString(
    "utf8",
  );
}
