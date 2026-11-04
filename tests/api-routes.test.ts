import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { ZodError, z } from "zod";
import { DomainError } from "../src/server/errors";
import { routes, type Route } from "../src/server/api/routes";
import { handle, matchRoute, dispatch, failure } from "../src/server/api/router";
import { openApiDocument } from "../src/server/api/openapi";
import { agentGuide } from "../src/server/api/guide";
import { actions, type Principal } from "../src/domain/permissions";
const owner: Principal = {
  id: "api-test",
  kind: "human",
  active: true,
  owner: true,
  grants: [],
};
const sample = "00000000-0000-4000-8000-000000000001";
const filled = (route: Route) => route.path.replace(/\{\w+\}/g, sample);
describe("the route table", () => {
  it("lists every route once, with a valid access and a published response", () => {
    expect(new Set(routes.map((route) => route.id)).size).toBe(routes.length);
    expect(new Set(routes.map((route) => `${route.method} ${route.path}`)).size).toBe(
      routes.length,
    );
    for (const route of routes) {
      expect([...actions, "owner", "human", "any"]).toContain(route.access);
      expect(route.summary.length).toBeGreaterThan(5);
      if (!route.binary) {
        // A response schema that accepts anything would publish nothing.
        expect(route.response.safeParse(Symbol("nothing")).success).toBe(false);
        expect(route.status ?? 200).toBeGreaterThanOrEqual(200);
      }
    }
  });
  it("matches every route to itself, so no route hides another", () => {
    for (const route of routes)
      expect(matchRoute(route.method, filled(route))?.route.id).toBe(route.id);
    expect(matchRoute("GET", "/tickets/search")?.route.id).toBe("tickets.search");
    expect(matchRoute("GET", `/tickets/${sample}`)?.route.id).toBe("tickets.get");
    expect(matchRoute("GET", `/tickets/${sample}/`)).toBeNull();
    expect(matchRoute("DELETE", `/tickets/${sample}`)).toBeNull();
    expect(matchRoute("GET", "/nothing")).toBeNull();
  });
  it("answers a route that is called without its path parameters with a refusal and never with a failure of the server", async () => {
    const withParameters = routes.filter((route) => /\{\w+\}/.test(route.path));
    expect(withParameters.length).toBeGreaterThan(30);
    for (const route of withParameters) {
      const answer = await Promise.resolve()
        .then(() =>
          route.run({
            principal: owner,
            params: {},
            query: new URLSearchParams(),
            input: {},
            request: new Request("http://localhost/api/v1"),
          }),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      // A route may answer an empty request (it then names no project), or refuse it; it does not break.
      if (answer !== null)
        expect(
          answer instanceof DomainError || answer instanceof ZodError,
          `${route.id}: ${answer instanceof Error ? answer.message : "not an error"}`,
        ).toBe(true);
    }
  });
  it("keeps the route file free of routes", () => {
    const file = readFileSync("src/app/api/v1/[[...path]]/route.ts", "utf8");
    expect(file.split("\n").length).toBeLessThan(12);
    expect(file).not.toContain("resource ===");
  });
});
describe("a caller without any right", () => {
  it("is refused or served an empty answer by every route, never with an unexpected error", async () => {
    const nobody: Principal = {
      id: "nobody",
      kind: "human",
      active: true,
      owner: false,
      grants: [],
    };
    for (const route of routes) {
      const params = Object.fromEntries(
        [...route.path.matchAll(/\{(\w+)\}/g)].map((found) => [found[1], sample]),
      );
      const outcome = await route
        .run({
          principal: nobody,
          params,
          query: new URLSearchParams({ q: "nothing" }),
          input: {},
          request: new Request("http://localhost:3000/"),
        })
        .then(
          () => "answered",
          (error: unknown) =>
            error instanceof DomainError || error instanceof ZodError
              ? "refused"
              : `unexpected: ${String(error)}`,
        );
      expect(["answered", "refused"], `${route.id}: ${outcome}`).toContain(outcome);
    }
  });
});
describe("the published definition", () => {
  const document = openApiDocument();
  it("is a valid OpenAPI 3.1 document, and an invalid copy is rejected", async () => {
    await expect(SwaggerParser.validate(structuredClone(document) as never)).resolves.toBeDefined();
    const broken = structuredClone(document) as Record<string, unknown>;
    delete broken.info;
    await expect(SwaggerParser.validate(broken as never)).rejects.toThrow();
    const dangling = structuredClone(document);
    dangling.paths["/projects"] = {
      get: { responses: { "200": { $ref: "#/components/schemas/Missing" } } },
    };
    await expect(SwaggerParser.validate(dangling as never)).rejects.toThrow();
  });
  it("describes every route with its parameters, body, response and access", () => {
    for (const route of routes) {
      const operation = (document.paths as Record<string, Record<string, Record<string, unknown>>>)[
        route.path
      ]?.[route.method.toLowerCase()];
      expect(operation?.operationId).toBe(route.id);
      expect(operation?.["x-required-access"]).toBe(route.access);
      const names = [...route.path.matchAll(/\{(\w+)\}/g)].map((found) => found[1]);
      const declared = (operation?.parameters as { name: string; in: string }[])
        .filter((parameter) => parameter.in === "path")
        .map((parameter) => parameter.name);
      expect(declared).toEqual(names);
      expect(Boolean(operation?.requestBody)).toBe(route.body !== undefined);
    }
  });
  it("equals the committed copy; run `pnpm api:docs` after changing the API", () => {
    expect(`${JSON.stringify(document, null, 2)}\n`).toBe(
      readFileSync("docs/api/openapi.json", "utf8"),
    );
  });
  it("points to the guide for agents, whose committed copy equals the published one", () => {
    expect(document.externalDocs.url).toBe("/api/v1/guide.md");
    expect(agentGuide).toBe(readFileSync("docs/api/agent-guide.md", "utf8"));
    // The guide names every query parameter and header it relies on.
    for (const word of ["expectedVersion", "expectedRevision", "validate=true", "idempotencyKey"])
      expect(agentGuide).toContain(word);
  });
  it("shows a changed route as a changed document", () => {
    const route = routes[0];
    if (!route) throw new Error("no routes");
    const summary = route.summary;
    route.summary = `${summary} changed`;
    try {
      expect(`${JSON.stringify(openApiDocument(), null, 2)}\n`).not.toBe(
        readFileSync("docs/api/openapi.json", "utf8"),
      );
    } finally {
      route.summary = summary;
    }
  });
});
describe("the router", () => {
  const added: Route[] = [];
  afterEach(() => {
    for (const route of added.splice(0)) routes.splice(routes.indexOf(route), 1);
  });
  const request = (path: string, init?: RequestInit) =>
    new Request(`http://localhost:3000/api/v1${path}`, init);
  it("serves the definition without a login and refuses everything else without one", async () => {
    const open = await dispatch(request("/openapi.json"));
    expect(open.status).toBe(200);
    expect(((await open.json()) as { openapi: string }).openapi).toBe("3.1.0");
    for (const path of ["/projects", "/nothing", `/tickets/${sample}`])
      expect((await dispatch(request(path))).status).toBe(401);
  });
  it("serves the guide for agents as Markdown without a login", async () => {
    const response = await dispatch(request("/guide.md"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toBe(agentGuide);
    expect((await dispatch(request("/guide.md", { method: "POST" }))).status).toBe(401);
  });
  it("answers an unknown path or method with not_found for a signed-in caller", async () => {
    for (const [path, method] of [
      ["/nothing", "GET"],
      [`/tickets/${sample}/`, "GET"],
      ["/projects", "DELETE"],
    ] as const) {
      const response = await handle(request(path, { method }), owner);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });
  it("turns a response that differs from its schema into an error outside production", async () => {
    const wrong: Route = {
      id: "test.wrong",
      method: "GET",
      path: "/test-wrong",
      tag: "Test",
      summary: "A route that answers the wrong shape",
      access: "any",
      mcp: { not: "A route of the test" },
      response: z.object({ ok: z.literal(true) }),
      run: () => Promise.resolve({ ok: "yes" }),
    };
    const right: Route = {
      ...wrong,
      id: "test.right",
      path: "/test-right",
      run: () => Promise.resolve({ ok: true }),
    };
    routes.push(wrong, right);
    added.push(wrong, right);
    const mismatch = await handle(request("/test-wrong"), owner);
    expect(mismatch.status).toBe(500);
    expect(await mismatch.json()).toMatchObject({
      error: "response_mismatch",
      route: "test.wrong",
    });
    const fine = await handle(request("/test-right"), owner);
    expect(fine.status).toBe(200);
    expect(await fine.json()).toEqual({ ok: true });
  });
  it("answers an unexpected failure with unavailable and tells nothing about it", async () => {
    const broken: Route = {
      id: "test.broken",
      method: "GET",
      path: "/test-broken",
      tag: "Test",
      summary: "A route that fails unexpectedly",
      access: "any",
      mcp: { not: "A route of the test" },
      response: z.object({}),
      run: () => Promise.reject(new Error("database password is hunter2")),
    };
    routes.push(broken);
    added.push(broken);
    const response = await handle(request("/test-broken"), owner);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"unavailable"}');
  });
  it("answers invalid JSON with invalid_input and a foreign origin with forbidden", async () => {
    const bad = await handle(
      request("/me/locale", {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
        body: "{",
      }),
      owner,
    );
    expect(bad.status).toBe(400);
    const foreign = await handle(
      request("/me/locale", {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: "{}",
      }),
      owner,
    );
    expect(foreign.status).toBe(403);
  });
});
describe("a wait that a provider asked for", () => {
  it("goes in the standard header and not in the body, and only when there is one", async () => {
    const waiting = failure(new DomainError("ai_rate_limited", 503, 120));
    expect(waiting.status).toBe(503);
    expect(waiting.headers.get("retry-after")).toBe("120");
    expect(await waiting.json()).toEqual({ error: "ai_rate_limited" });
    const plain = failure(new DomainError("ai_rate_limited", 503));
    expect(plain.headers.get("retry-after")).toBeNull();
    expect(failure(new DomainError("not_found", 404)).headers.get("retry-after")).toBeNull();
  });
});
