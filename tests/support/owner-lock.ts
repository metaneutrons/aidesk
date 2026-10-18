import { sqlClient } from "../../src/server/db";
// The tests of the first owner remove every row of an owner, and the tests of the passkey of the owner need theirs: run
// side by side in two files they delete each other's owner. A session lock of the database keeps the two files apart,
// each for as long as it runs.
const key = 7_650_001;
type Reserved = Awaited<ReturnType<ReturnType<typeof sqlClient>["reserve"]>>;
let held: Reserved | undefined;
export async function lockOwners(): Promise<void> {
  held = await sqlClient().reserve();
  await held`select pg_advisory_lock(${key})`;
}
export async function unlockOwners(): Promise<void> {
  if (!held) return;
  await held`select pg_advisory_unlock(${key})`;
  held.release();
  held = undefined;
}
