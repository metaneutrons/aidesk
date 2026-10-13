import { z } from "zod";
import { routes, type Route } from "./routes";
import { errorBody } from "./schemas";
// The published API definition (OpenAPI 3.1), generated from the route table.
// Schemas with an id (rows such as a ticket) are written once under
// components and referenced; the rest is inline.
const shared: Record<string, unknown> = {};
const json = (schema: z.ZodType, io: "input" | "output") => {
  const { $defs, ...rest } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    unrepresentable: "any",
  }) as Record<string, unknown>;
  Object.assign(shared, $defs ?? {});
  return JSON.parse(JSON.stringify(rest).replaceAll("#/$defs/", "#/components/schemas/")) as Record<
    string,
    unknown
  >;
};
const schemaOnly = (schema: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema"));
function parameters(route: Route) {
  const path = [...route.path.matchAll(/\{(\w+)\}/g)].map((found) => ({
    name: found[1],
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  }));
  const query = route.query
    ? Object.entries(route.query.shape).map(([name, schema]) => {
        const described = schemaOnly(json(schema as z.ZodType, "input"));
        const { description, ...rest } = described as { description?: string };
        return {
          name,
          in: "query",
          required: !(schema as z.ZodType).safeParse(undefined).success,
          ...(description ? { description } : {}),
          schema: rest,
        };
      })
    : [];
  return [...path, ...query];
}
const problems = [
  ["400", "The request body or a parameter is not valid"],
  ["401", "Not signed in or token not valid"],
  ["403", "The caller may not do this"],
  ["404", "Not found, or not visible to the caller"],
  ["409", "The state does not allow this"],
  ["503", "Temporarily unavailable"],
] as const;
export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const status = String(route.binary ? 200 : (route.status ?? 200));
    const success = route.binary
      ? {
          description: "The file",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        }
      : {
          description: "Success",
          content: { "application/json": { schema: schemaOnly(json(route.response, "output")) } },
        };
    const alsoStatus = route.binary ? [] : (route.alsoStatus ?? []);
    const operation = {
      operationId: route.id,
      tags: [route.tag],
      summary: route.summary,
      "x-required-access": route.access,
      parameters: parameters(route),
      ...(!route.binary && route.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: schemaOnly(json(route.body, "input")) } },
            },
          }
        : {}),
      responses: {
        [status]: success,
        ...Object.fromEntries(
          alsoStatus.map((code) => [
            String(code),
            { ...success, description: "Accepted, not yet in effect" },
          ]),
        ),
        ...Object.fromEntries(
          problems.map(([code]) => [code, { $ref: `#/components/responses/Problem${code}` }]),
        ),
      },
    };
    (paths[route.path] ??= {})[route.method.toLowerCase()] = operation;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "aidesk API",
      version: "0.1.0",
      description:
        "REST API of aidesk. Every route is generated from one route table; the access of a route names the action that has to be granted for the project concerned.",
    },
    servers: [{ url: "/api/v1" }],
    security: [{ bearer: [] }, { session: [] }],
    paths,
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description: "An agent token issued for a project.",
        },
        session: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
          description:
            "The operator session. Requests that change data must carry the application's own Origin header.",
        },
      },
      responses: Object.fromEntries(
        problems.map(([code, description]) => [
          `Problem${code}`,
          {
            description,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        ]),
      ),
      schemas: { ...shared, Error: schemaOnly(json(errorBody, "output")) },
    },
  };
}
