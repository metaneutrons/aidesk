import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { env } from "../env";
const state = globalThis as typeof globalThis & { aideskSql?: ReturnType<typeof postgres> };
export function sqlClient(): ReturnType<typeof postgres> {
  state.aideskSql ??= postgres(env().DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return state.aideskSql;
}
export function db(): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(sqlClient(), { schema });
}
