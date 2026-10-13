// Applies the migrations once before the test files start in parallel. Each
// file still calls migrate(), which is then a no-op; on a fresh database,
// concurrent first runs race on CREATE TYPE and CREATE TABLE and fail.
//
// The test database is shared by every branch of a checkout. When it holds a
// migration that this branch does not have, it is emptied first (it only ever
// holds test data, and setup-env refuses any other database).
export default async function setup(): Promise<void> {
  await import("./setup-env");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { sql } = await import("drizzle-orm");
  const { db, sqlClient } = await import("../src/server/db");
  const { foreignMigrations, knownMigrationHashes } = await import("./support/migrations");
  const applied = await db()
    .execute<{ hash: string }>(sql`select hash from drizzle.__drizzle_migrations`)
    .then((rows) => rows.map((row) => row.hash))
    .catch(() => []);
  if (foreignMigrations(applied, knownMigrationHashes()).length > 0) {
    console.log("The test database holds migrations of another branch; starting it again.");
    await db().execute(sql`drop schema if exists drizzle cascade`);
    await db().execute(sql`drop schema if exists public cascade`);
    await db().execute(sql`create schema public`);
  }
  await migrate(db(), { migrationsFolder: "drizzle" });
  await sqlClient().end();
}
