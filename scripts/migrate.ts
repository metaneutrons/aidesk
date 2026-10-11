import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
await migrate(db(), { migrationsFolder: "drizzle" });
await sqlClient().end();
console.log("Database migrations applied.");
