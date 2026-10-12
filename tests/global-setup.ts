// Applies the migrations once before the test files start in parallel. Each
// file still calls migrate(), which is then a no-op; on a fresh database,
// concurrent first runs race on CREATE TYPE and CREATE TABLE and fail.
export default async function setup(): Promise<void> {
  await import("./setup-env");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { db, sqlClient } = await import("../src/server/db");
  await migrate(db(), { migrationsFolder: "drizzle" });
  await sqlClient().end();
}
