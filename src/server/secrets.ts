import { seal, unseal } from "./crypto";
import { env } from "./env";
// The two secrets of the installation and how they are rotated. A rotation sets the new value in
// `ENCRYPTION_KEY` / `BETTER_AUTH_SECRET` and keeps the old one in `..._PREVIOUS` until the keys job has re-protected
// everything (see `key-rotation.ts`). In between, reading works with either, writing always uses the current one, so a
// run that fails halfway leaves every value readable.
//
// Stored secrets (connections, webhooks, single sign-on, sealed proposals) are sealed with `ENCRYPTION_KEY`.
export const sealSecret = (value: string): string => seal(value, env().ENCRYPTION_KEY);
// A value read with the current key, or else with the previous one while a rotation is in progress.
export function unsealSecret(value: string): string {
  try {
    return unseal(value, env().ENCRYPTION_KEY);
  } catch (error) {
    const previous = env().ENCRYPTION_KEY_PREVIOUS;
    if (!previous) throw error;
    return unseal(value, previous);
  }
}
// Which key protects a sealed value: the current one, only the previous one, or none of them.
export function sealState(value: string): "current" | "previous" | "unreadable" {
  try {
    unseal(value, env().ENCRYPTION_KEY);
    return "current";
  } catch {
    const previous = env().ENCRYPTION_KEY_PREVIOUS;
    if (!previous) return "unreadable";
    try {
      unseal(value, previous);
      return "previous";
    } catch {
      return "unreadable";
    }
  }
}
// What Better Auth and the owner's own encrypted values use: the current secret with its version, the previous one
// with the version before, and the oldest secret for values that carry no version.
export function authSecrets() {
  const { BETTER_AUTH_SECRET, BETTER_AUTH_SECRET_PREVIOUS, BETTER_AUTH_SECRET_VERSION } = env();
  const secrets = [
    { version: BETTER_AUTH_SECRET_VERSION, value: BETTER_AUTH_SECRET },
    ...(BETTER_AUTH_SECRET_PREVIOUS
      ? [{ version: BETTER_AUTH_SECRET_VERSION - 1, value: BETTER_AUTH_SECRET_PREVIOUS }]
      : []),
  ];
  return {
    secrets,
    legacy: BETTER_AUTH_SECRET_PREVIOUS ?? BETTER_AUTH_SECRET,
    config: {
      keys: new Map(secrets.map((secret) => [secret.version, secret.value])),
      currentVersion: BETTER_AUTH_SECRET_VERSION,
      legacySecret: BETTER_AUTH_SECRET_PREVIOUS ?? BETTER_AUTH_SECRET,
    },
  };
}
