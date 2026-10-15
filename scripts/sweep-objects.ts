// Finds the objects in the bucket that no row names and, with --delete, removes them.
//   pnpm tsx scripts/sweep-objects.ts                    lists what would go (a dry run)
//   pnpm tsx scripts/sweep-objects.ts --delete           removes it
//   --grace-hours=N                                      keep objects younger than N hours (24)
import { sqlClient } from "../src/server/db";
import { sweepObjects } from "../src/server/object-sweep";
const args = process.argv.slice(2);
const hours = Number(args.find((arg) => arg.startsWith("--grace-hours="))?.split("=")[1] ?? "24");
if (!Number.isFinite(hours) || hours < 0) throw new Error("--grace-hours needs a number");
const remove = args.includes("--delete");
const result = await sweepObjects({ remove, graceMs: hours * 3600 * 1000 });
console.log(
  JSON.stringify({
    mode: remove ? "delete" : "dry run",
    scanned: result.scanned,
    referenced: result.referenced,
    unreferenced: result.unreferenced.length,
    bytes: result.unreferenced.reduce((sum, object) => sum + object.size, 0),
    keptBecauseYoung: result.tooYoung,
    deleted: result.deleted,
    failed: result.failed.length,
  }),
);
for (const object of result.unreferenced.slice(0, 20)) console.log(object.key);
await sqlClient().end();
if (result.failed.length > 0) process.exitCode = 1;
