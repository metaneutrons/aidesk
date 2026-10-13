import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
// The hashes drizzle records for the migrations of this checkout: the SHA-256
// of each SQL file.
export function knownMigrationHashes(folder = "drizzle"): Set<string> {
  return new Set(
    readdirSync(folder)
      .filter((file) => file.endsWith(".sql"))
      .map((file) =>
        createHash("sha256")
          .update(readFileSync(`${folder}/${file}`))
          .digest("hex"),
      ),
  );
}
// Migrations that the database has applied and this checkout does not have.
// They come from another branch; the schema is then not the one the code
// expects, and drizzle would skip a migration that is older than the last one
// applied, so the database has to start again.
export function foreignMigrations(applied: readonly string[], known: ReadonlySet<string>) {
  return applied.filter((hash) => !known.has(hash));
}
