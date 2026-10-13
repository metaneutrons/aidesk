import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { foreignMigrations, knownMigrationHashes } from "./support/migrations";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
describe("migrations of the test database", () => {
  it("hashes the SQL files of a folder like drizzle does", () => {
    const folder = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      writeFileSync(join(folder, "0000_a.sql"), "create table a (id int);");
      writeFileSync(join(folder, "0001_b.sql"), "create table b (id int);");
      writeFileSync(join(folder, "notes.txt"), "ignored");
      expect(knownMigrationHashes(folder)).toEqual(
        new Set([sha("create table a (id int);"), sha("create table b (id int);")]),
      );
    } finally {
      rmSync(folder, { recursive: true });
    }
  });
  it("finds applied migrations that this checkout does not have", () => {
    const known = new Set(["a", "b"]);
    expect(foreignMigrations(["a", "b"], known)).toEqual([]);
    expect(foreignMigrations(["a"], known)).toEqual([]);
    expect(foreignMigrations([], known)).toEqual([]);
    expect(foreignMigrations(["a", "x", "y"], known)).toEqual(["x", "y"]);
  });
  it("knows the real migrations of this checkout", () => {
    // The first migration of the repository is in every checkout.
    expect(knownMigrationHashes().size).toBeGreaterThan(5);
  });
});
