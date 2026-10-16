import { timingSafeEqual } from "node:crypto";
import { runBounded } from "../../../../worker/pass";
// The worker for a platform that runs a function for a limited time and calls it from a schedule
// (Vercel cron, or any scheduler): one call works the queue until it is empty or the time is up.
// It needs the secret `CRON_SECRET` (at least 32 characters) in the header `Authorization: Bearer`,
// which Vercel sends by itself for a cron job; without a secret in the environment the route does
// not exist. The Docker stack does not use it.
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const defaultBudgetMs = 45_000;
const longestBudgetMs = 50_000;
function allowed(request: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < 32) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
async function tick(request: Request): Promise<Response> {
  if ((process.env.CRON_SECRET ?? "").length < 32)
    return Response.json({ error: "not_found" }, { status: 404 });
  if (!allowed(request)) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const asked = Number(new URL(request.url).searchParams.get("budget"));
  const budget =
    Number.isFinite(asked) && asked > 0 ? Math.min(asked, longestBudgetMs) : defaultBudgetMs;
  const started = Date.now();
  const result = await runBounded(budget);
  return Response.json({ ...result, ms: Date.now() - started });
}
export const GET = tick;
export const POST = tick;
