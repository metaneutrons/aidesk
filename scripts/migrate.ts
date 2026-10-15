import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { initializeStorage } from "../src/server/storage";
// Prepares a deployment: the schema of the database and the bucket of the storage,
// which nothing else creates (the web server reports itself not ready without it).
await migrate(db(), { migrationsFolder: "drizzle" });
await sqlClient().end();
console.log("Database migrations applied.");
await initializeStorage();
console.log("Storage bucket ready.");
