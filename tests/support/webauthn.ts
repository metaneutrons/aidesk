import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
// A software authenticator for the tests: an ES256 key pair, the public key as the COSE key that
// the passkey plugin stores, and assertions as a browser would hand them over.
const b64url = (data: Buffer) => data.toString("base64url");
export interface SoftPasskey {
  credentialId: string;
  publicKey: string;
  privateKey: KeyObject;
}
export function softPasskey(): SoftPasskey {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x ?? "", "base64url");
  const y = Buffer.from(jwk.y ?? "", "base64url");
  // {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y} as CBOR.
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
  return {
    credentialId: b64url(randomBytes(16)),
    publicKey: cose.toString("base64"),
    privateKey,
  };
}
export function assertion(
  key: SoftPasskey,
  options: { challenge: string; rpId: string; origin: string; counter: number; verified: boolean },
) {
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: options.challenge,
      origin: options.origin,
      crossOrigin: false,
    }),
  );
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(options.counter);
  // Flags: user present (1), user verified (4).
  const authenticatorData = Buffer.concat([
    createHash("sha256").update(options.rpId).digest(),
    Buffer.from([options.verified ? 0x05 : 0x01]),
    counter,
  ]);
  const signature = createSign("sha256")
    .update(
      Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
    )
    .sign(key.privateKey);
  return {
    id: key.credentialId,
    rawId: key.credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      authenticatorData: b64url(authenticatorData),
      clientDataJSON: b64url(clientDataJSON),
      signature: b64url(signature),
    },
  };
}
