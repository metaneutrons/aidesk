import { pollMailboxes, runIngest, runNext, runTestSend } from "./jobs";
import { runExtractions } from "./extract";
import { runAgents } from "./agent-runs";
import { runImageReadings } from "./read-images";
import { runWebhooks } from "./webhooks";
import { runNotificationMail } from "./notification-mail";
import { runTranslations } from "./translate";
import { scanAutoResolve } from "../server/auto-resolve";
import { scanRetention } from "../server/retention";
import { pruneNotifications } from "../server/notifications";
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
// A pass that takes long holds back every job that waits for the next one (a test mail, a webhook, a reply), so the pass
// says where the time went when it took five seconds or more: the stages that took a quarter of a second or more.
export const slowPassMs = 5_000;
export function slowStages(stages: Record<string, number>, ceiling = slowPassMs) {
  const total = Object.values(stages).reduce((sum, ms) => sum + ms, 0);
  if (total < ceiling) return null;
  return {
    event: "worker.pass_slow",
    ms: total,
    stages: Object.fromEntries(Object.entries(stages).filter(([, ms]) => ms >= 250)),
  };
}
export async function runPass(): Promise<boolean> {
  const spent: Record<string, number> = {};
  const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const at = Date.now();
    try {
      return await run();
    } finally {
      spent[name] = Date.now() - at;
    }
  };
  if (Date.now() >= nextClockScan) {
    nextClockScan = Date.now() + 30_000;
    await timed("clock", scanResponseClock);
  }
  if (Date.now() >= nextIssueRefresh) {
    nextIssueRefresh = Date.now() + 5 * 60_000;
    await timed("issues", reconcileIssues);
  }
  // The reminders and the automatic resolve are counted in days, so every five minutes is often enough.
  if (Date.now() >= nextAutoResolve) {
    nextAutoResolve = Date.now() + 5 * 60_000;
    await timed("autoResolve", scanAutoResolve);
  }
  // What a retention period has made due is removed in steps; a quarter of an hour between passes is enough.
  if (Date.now() >= nextRetention) {
    nextRetention = Date.now() + 15 * 60_000;
    await timed("retention", async () => {
      await scanRetention();
      await pruneNotifications();
    });
  }
  await timed("mailboxes", pollMailboxes);
  const done = [
    await timed("ingest", runIngest),
    await timed("replies", runNext),
    await timed("testMail", runTestSend),
    await timed("webhooks", runWebhooks),
    await timed("notificationMail", runNotificationMail),
    await timed("extractions", runExtractions),
    await timed("imageReadings", runImageReadings),
    await timed("agents", runAgents),
    await timed("translations", runTranslations),
  ];
  const slow = slowStages(spent);
  if (slow) console.log(JSON.stringify(slow));
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
