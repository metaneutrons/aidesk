import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
// The development server builds a page or a route when it is asked for it the first time, and in CI that
// takes longer than the five seconds that an assertion waits, so the first test that reaches a route failed
// now and then (the issues, the webhooks, the portal and the owner specs, in different pull requests). This
// asks for every page and route once, before the first test, with as much time as a build needs. The list
// is read from the files under `src/app`, so that a new route is warmed without anyone remembering it.
// What comes back does not matter (a refusal builds the route as well); a route that cannot be reached is
// left to the tests, which say what is wrong. A deployment is built already and is not asked.
interface Call {
  method: "GET" | "POST";
  path: string;
}
// A segment in brackets stands for a value: any text will do to reach the code of the route.
function pathOf(directory: string): string {
  const parts = directory
    .split(sep)
    .filter(Boolean)
    .map((part) => (part.startsWith("[[...") ? "" : part.startsWith("[") ? "warm-up" : part))
    .filter(Boolean);
  return `/${parts.join("/")}`;
}
export function calls(root = join("src", "app")): Call[] {
  const found: Call[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(directory, entry.name));
      else if (entry.name === "page.tsx") found.push({ method: "GET", path: pathOf(directory) });
      else if (entry.name === "route.ts") {
        // The route of the API answers its own paths; asking for the base is enough to build it.
        const path = pathOf(directory);
        found.push({ method: "GET", path }, { method: "POST", path });
      }
    }
  };
  walk("");
  return found;
}
export default async function warmUp(): Promise<void> {
  if (process.env.E2E_FIXTURE_ENV_FILE) return;
  const base = process.env.E2E_BASE_URL ?? "http://localhost:3000";
  const started = Date.now();
  for (const call of calls()) {
    const at = Date.now();
    const answer = await fetch(new URL(call.path, base), {
      method: call.method,
      headers: { origin: new URL(base).origin, "content-type": "application/json" },
      ...(call.method === "POST" ? { body: "{}" } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    }).then(
      (response) => String(response.status),
      () => "unreachable",
    );
    console.log(`warm-up ${call.method} ${call.path}: ${answer} in ${String(Date.now() - at)} ms`);
  }
  console.log(`warm-up: ${String(Date.now() - started)} ms`);
}
