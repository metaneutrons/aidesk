// Scheduler for aidesk on a platform whose own schedule runs once a day. A Cron Trigger calls the worker of the
// deployment every minute; one call works the queue until it is empty or its time is up (src/app/api/worker/tick).
// The address and the secret are secrets of this Worker, not part of the repository. A refusal or an error makes the
// run fail, so that it shows in the log of the Worker. The types below are the subset of the Workers runtime that
// this file uses.
interface Env {
  TICK_URL: string;
  CRON_SECRET: string;
}
interface Context {
  waitUntil(promise: Promise<unknown>): void;
}
async function tick(env: Env): Promise<void> {
  const response = await fetch(env.TICK_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CRON_SECRET}` },
    signal: AbortSignal.timeout(55_000),
  });
  const body = await response.text();
  console.log(JSON.stringify({ event: "tick", status: response.status, body: body.slice(0, 300) }));
  if (!response.ok) throw new Error(`The tick answered ${String(response.status)}`);
}
export default {
  scheduled(_event: unknown, env: Env, context: Context): void {
    context.waitUntil(tick(env));
  },
  fetch(): Response {
    return new Response("not found", { status: 404 });
  },
};
