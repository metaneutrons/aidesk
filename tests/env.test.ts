import { afterEach, describe, expect, it, vi } from "vitest";
// The configuration is read from the environment once; the example file for a
// deployment lists the owner token with no value, which has to mean "none".
async function read(token: string | undefined) {
  vi.resetModules();
  if (token === undefined) vi.stubEnv("OWNER_CLAIM_TOKEN", undefined);
  else vi.stubEnv("OWNER_CLAIM_TOKEN", token);
  return (await import("../src/server/env")).env();
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe("the owner token of the configuration", () => {
  it("is none when it is not set or empty, so that the example file can list it without a value", async () => {
    expect((await read("")).OWNER_CLAIM_TOKEN).toBeUndefined();
    expect((await read(undefined)).OWNER_CLAIM_TOKEN).toBeUndefined();
  });
  it("is kept when it has 32 characters or more, and refused when it is shorter", async () => {
    const token = "x".repeat(32);
    expect((await read(token)).OWNER_CLAIM_TOKEN).toBe(token);
    await expect(read("too-short")).rejects.toThrow();
  });
});
