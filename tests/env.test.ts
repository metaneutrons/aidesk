import { afterEach, describe, expect, it, vi } from "vitest";
// The configuration is read from the environment once; the example file for a
// deployment lists the owner token with no value, which has to mean "none".
async function read(token: string | undefined, extra: Record<string, string | undefined> = {}) {
  vi.resetModules();
  if (token === undefined) vi.stubEnv("OWNER_CLAIM_TOKEN", undefined);
  else vi.stubEnv("OWNER_CLAIM_TOKEN", token);
  for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value);
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
describe("the settings of the database connection", () => {
  it("default to ten connections with prepared statements, also when the example file leaves them empty", async () => {
    const empty = await read("", { DATABASE_POOL_MAX: "", DATABASE_PREPARE: "" });
    expect([empty.DATABASE_POOL_MAX, empty.DATABASE_PREPARE]).toEqual([10, "true"]);
    const unset = await read("", { DATABASE_POOL_MAX: undefined, DATABASE_PREPARE: undefined });
    expect([unset.DATABASE_POOL_MAX, unset.DATABASE_PREPARE]).toEqual([10, "true"]);
  });
  it("take one connection and no prepared statements for a pooler in transaction mode", async () => {
    const set = await read("", { DATABASE_POOL_MAX: "1", DATABASE_PREPARE: "false" });
    expect([set.DATABASE_POOL_MAX, set.DATABASE_PREPARE]).toEqual([1, "false"]);
  });
  it("refuse a number of connections that is none, too many or not a number, and a switch that is not true or false", async () => {
    for (const value of ["0", "51", "many", "1.5"])
      await expect(read("", { DATABASE_POOL_MAX: value })).rejects.toThrow();
    await expect(read("", { DATABASE_PREPARE: "no" })).rejects.toThrow();
  });
});
describe("the connection that the settings make", () => {
  it("has the number of connections and the prepared statements that the environment asks for", async () => {
    const state = globalThis as typeof globalThis & { aideskSql?: { end: () => Promise<void> } };
    for (const [max, prepare] of [
      ["1", "false"],
      ["10", "true"],
    ] as const) {
      vi.resetModules();
      delete state.aideskSql;
      vi.stubEnv("DATABASE_POOL_MAX", max);
      vi.stubEnv("DATABASE_PREPARE", prepare);
      const { sqlClient } = await import("../src/server/db");
      const client = sqlClient();
      expect([client.options.max, client.options.prepare]).toEqual([
        Number(max),
        prepare === "true",
      ]);
      await client.end();
      delete state.aideskSql;
    }
  });
});
