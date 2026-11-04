import { sql } from "drizzle-orm";
import { db } from "./db";
// Periodic work with a limit that holds for every process. The worker of the Docker stack lives long and keeps the
// time of its last look in memory, but a platform that calls the worker from a schedule may start a new process for each
// call, so a limit in memory would not hold: every call would poll the mailboxes and scan the clock again. The time of
// the last claim is kept in the table of the workspace settings, and one statement decides, so that of several calls
// at once exactly one gets the slot. The time is the one of the database, so processes need no common clock.
// The slot opens a little before the interval is over (a tenth of it, at most five seconds), because calls that are
// made every minute by a scheduler differ by some milliseconds and would otherwise skip every second one.
export async function claimSlot(name: string, everyMs: number): Promise<boolean> {
  const grace = Math.min(5_000, Math.floor(everyMs / 10));
  const rows = await db().execute<{ key: string }>(sql`
    insert into workspace_setting (key, value)
    values (${`schedule:${name}`}, jsonb_build_object('at', (extract(epoch from clock_timestamp()) * 1000)::bigint))
    on conflict (key) do update
      set value = excluded.value, updated_at = now()
      where (workspace_setting.value->>'at')::bigint
        <= (extract(epoch from clock_timestamp()) * 1000)::bigint - ${everyMs - grace}::bigint
    returning key`);
  return rows.length > 0;
}
