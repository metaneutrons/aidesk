import { pollMailboxes, runIngest, runNext, runTestSend } from "./jobs";
import { runExtractions } from "./extract";
import { runAgents } from "./agent-runs";
import { runImageReadings } from "./read-images";
import { runWebhooks } from "./webhooks";
import { runTranslations } from "./translate";
import { scanAutoResolve } from "../server/auto-resolve";
import { scanRetention } from "../server/retention";
import { scanResponseClock } from "../server/response-clock";
import { reconcileIssues } from "../server/issues";
// The work of the worker, in passes that end: one pass looks at the clock, polls the mailboxes and
// takes the next job of each kind once. The same pass serves the worker of the Docker stack, which
// repeats it without end, and a platform that runs a function for a limited time and calls it from
// a schedule (`/api/worker/tick`), which repeats it until nothing is left or the time is up. A job
// is claimed under a lease, so a pass that is cut off leaves its job to the next one.
// The response clock is looked at about every half minute and the issues every five minutes; the
// limits they watch are counted in hours and days. A process that lives only for one call looks at
// both on every call.
let nextClockScan = 0;
let nextIssueRefresh = 0;
let nextAutoResolve = 0;
let nextRetention = 0;
export async function runPass(): Promise<boolean> {
  if (Date.now() >= nextClockScan) {
    nextClockScan = Date.now() + 30_000;
    await scanResponseClock();
  }
  if (Date.now() >= nextIssueRefresh) {
    nextIssueRefresh = Date.now() + 5 * 60_000;
    await reconcileIssues();
  }
  // The reminders and the automatic resolve are counted in days, so every five minutes is often enough.
  if (Date.now() >= nextAutoResolve) {
    nextAutoResolve = Date.now() + 5 * 60_000;
    await scanAutoResolve();
  }
  // What a retention period has made due is removed in steps; a quarter of an hour between passes is enough.
  if (Date.now() >= nextRetention) {
    nextRetention = Date.now() + 15 * 60_000;
    await scanRetention();
  }
  await pollMailboxes();
  const done = [
    await runIngest(),
    await runNext(),
    await runTestSend(),
    await runWebhooks(),
    await runExtractions(),
    await runImageReadings(),
    await runAgents(),
    await runTranslations(),
  ];
  return done.some(Boolean);
}
// Passes until one finds nothing to do or the time is up; the time is checked between passes, so
// a pass that has started is finished.
export async function runBounded(
  budgetMs: number,
  pass: () => Promise<boolean> = runPass,
  now: () => number = Date.now,
): Promise<{ passes: number; idle: boolean }> {
  const end = now() + budgetMs;
  let passes = 0;
  for (;;) {
    const worked = await pass();
    passes += 1;
    if (!worked) return { passes, idle: true };
    if (now() >= end) return { passes, idle: false };
  }
}
