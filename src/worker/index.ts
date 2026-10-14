import { setTimeout as delay } from "node:timers/promises";
import { sqlClient } from "../server/db";
import { pollMailboxes, runIngest, runNext, runTestSend } from "./jobs";
import { runWebhooks } from "./webhooks";
const lifecycle = { stopped: false };
process.on("SIGTERM", () => {
  lifecycle.stopped = true;
});
process.on("SIGINT", () => {
  lifecycle.stopped = true;
});
console.log(JSON.stringify({ event: "worker.ready" }));
while (!lifecycle.stopped) {
  try {
    await pollMailboxes();
    const ingested = await runIngest();
    const sent = await runNext();
    const tested = await runTestSend();
    const notified = await runWebhooks();
    if (!ingested && !sent && !tested && !notified) await delay(1000);
  } catch {
    console.log(JSON.stringify({ event: "worker.database_unavailable" }));
    await delay(3000);
  }
}
await sqlClient().end();
