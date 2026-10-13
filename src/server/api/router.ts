import { ZodError } from "zod";
import { identify, requireMutationOrigin } from "../principal";
import type { Principal } from "../../domain/permissions";
import { DomainError } from "../errors";
import { routes, type Route } from "./routes";
import { openApiDocument } from "./openapi";
// Turns a path template such as /tickets/{ticketId} into a matcher. A path has
// exactly the segments of its template; a trailing slash matches nothing.
function compile(route: Route) {
  const names: string[] = [];
  const pattern = route.path
    .split("/")
    .map((segment) => {
      const name = /^\{(\w+)\}$/.exec(segment)?.[1];
      if (name === undefined) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(name);
      return "([^/]+)";
    })
    .join("/");
  return { route, names, expression: new RegExp(`^${pattern}$`) };
}
const cache = new Map<Route, ReturnType<typeof compile>>();
const compiledOf = (route: Route) => {
  let entry = cache.get(route);
  if (!entry) cache.set(route, (entry = compile(route)));
  return entry;
};
export function matchRoute(method: string, path: string) {
  for (const entry of routes.map(compiledOf)) {
    if (entry.route.method !== method) continue;
    const found = entry.expression.exec(path);
    if (!found) continue;
    const params: Record<string, string> = {};
    entry.names.forEach((name, index) => {
      params[name] = decodeURIComponent(found[index + 1] ?? "");
    });
    return { route: entry.route, params };
  }
  return null;
}
const prefix = "/api/v1";
export async function dispatch(request: Request): Promise<Response> {
  try {
    // The definition is public: it describes the API, not data.
    if (request.method === "GET" && new URL(request.url).pathname === `${prefix}/openapi.json`)
      return Response.json(openApiDocument(), {
        headers: { "Cache-Control": "public, max-age=300" },
      });
    return await handle(request, await identify(request.headers));
  } catch (error) {
    return failure(error);
  }
}
function failure(error: unknown): Response {
  if (error instanceof DomainError)
    return Response.json({ error: error.code }, { status: error.status });
  if (error instanceof ZodError || error instanceof SyntaxError)
    return Response.json({ error: "invalid_input" }, { status: 400 });
  return Response.json({ error: "unavailable" }, { status: 503 });
}
// Runs a request for an identified caller against the route table.
export async function handle(request: Request, principal: Principal): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.slice(prefix.length);
    let input: unknown = {};
    if (request.method === "POST") {
      requireMutationOrigin(request);
      // Commands such as revoke carry no body.
      const text = await request.text();
      input = text ? JSON.parse(text) : {};
    }
    const matched = matchRoute(request.method, path);
    if (!matched) return Response.json({ error: "not_found" }, { status: 404 });
    const { route, params } = matched;
    const result = await route.run({ principal, params, query: url.searchParams, input, request });
    if (route.binary) return result as Response;
    // Outside production a response that differs from its published schema is
    // an error, so the definition cannot drift unnoticed.
    if (process.env.NODE_ENV !== "production") {
      const checked = route.response.safeParse(JSON.parse(JSON.stringify(result)));
      if (!checked.success)
        return Response.json(
          { error: "response_mismatch", route: route.id, issues: checked.error.issues.slice(0, 5) },
          { status: 500 },
        );
    }
    return Response.json(result, {
      status: route.status ?? 200,
      ...(route.headers ? { headers: route.headers } : {}),
    });
  } catch (error) {
    return failure(error);
  }
}
