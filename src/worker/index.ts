import { setTimeout as delay } from "node:timers/promises";
import { sqlClient } from "../server/db";
import { pollMailboxes, runIngest, runNext, runTestSend } from "./jobs";
import { runExtractions } from "./extract";
import { runAgents } from "./agent-runs";
import { runImageReadings } from "./read-images";
import { runWebhooks } from "./webhooks";
import { runTranslations } from "./translate";
import { scanResponseClock } from "../server/response-clock";
const lifecycle = { stopped: false };
process.on("SIGTERM", () => {
  lifecycle.stopped = true;
});
process.on("SIGINT", () => {
  lifecycle.stopped = true;
});
// The response clock is looked at about every half minute; the limits are counted in hours.
let nextClockScan = 0;
console.log(JSON.stringify({ event: "worker.ready" }));
while (!lifecycle.stopped) {
  try {
    if (Date.now() >= nextClockScan) {
      nextClockScan = Date.now() + 30_000;
      await scanResponseClock();
    }
    await pollMailboxes();
    const ingested = await runIngest();
    const sent = await runNext();
    const tested = await runTestSend();
    const notified = await runWebhooks();
    const read = await runExtractions();
    const seen = await runImageReadings();
    const worked = await runAgents();
    const translated = await runTranslations();
    if (!ingested && !sent && !tested && !notified && !read && !seen && !worked && !translated)
      await delay(1000);
  } catch {
    console.log(JSON.stringify({ event: "worker.database_unavailable" }));
    await delay(3000);
  }
}
await sqlClient().end();
