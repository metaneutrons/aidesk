import { setTimeout as delay } from "node:timers/promises";
import { sqlClient } from "../server/db";
import { runPass } from "./pass";
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
    if (!(await runPass())) await delay(1000);
  } catch {
    console.log(JSON.stringify({ event: "worker.database_unavailable" }));
    await delay(3000);
  }
}
await sqlClient().end();
