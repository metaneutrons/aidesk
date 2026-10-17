// The development server builds a page or a route when it is asked for it the first time, and in CI that
// takes longer than the five seconds that an assertion waits, so the first test that reaches a route failed
// now and then (the issues, the webhooks and the portal specs, in three different pull requests). This asks
// for each page and route once, before the first test, with as much time as a build needs. What comes
// back does not matter (a refusal builds the route as well); a route that cannot be reached is left to the
// tests, which say what is wrong. A deployment is built already and is not asked.
const routes: { method: "GET" | "POST"; path: string }[] = [
  { method: "GET", path: "/" },
  { method: "GET", path: "/login" },
  { method: "GET", path: "/setup" },
  { method: "GET", path: "/recover" },
  { method: "GET", path: "/portal/warm-up" },
  { method: "GET", path: "/api/health/ready" },
  { method: "GET", path: "/api/v1/projects" },
  { method: "GET", path: "/api/auth/get-session" },
  { method: "POST", path: "/api/portal/reply" },
  { method: "POST", path: "/api/mcp" },
  { method: "POST", path: "/api/setup/owner" },
  { method: "POST", path: "/api/recover/owner" },
  { method: "GET", path: "/api/worker/tick" },
];
export default async function warmUp(): Promise<void> {
  if (process.env.E2E_FIXTURE_ENV_FILE) return;
  const base = process.env.E2E_BASE_URL ?? "http://localhost:3000";
  const started = Date.now();
  for (const route of routes) {
    const at = Date.now();
    const answer = await fetch(new URL(route.path, base), {
      method: route.method,
      headers: { origin: new URL(base).origin, "content-type": "application/json" },
      ...(route.method === "POST" ? { body: "{}" } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    }).then(
      (response) => String(response.status),
      () => "unreachable",
    );
    console.log(
      `warm-up ${route.method} ${route.path}: ${answer} in ${String(Date.now() - at)} ms`,
    );
  }
  console.log(`warm-up: ${String(Date.now() - started)} ms`);
}
