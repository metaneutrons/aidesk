import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { identify } from "./principal";
import { DomainError } from "./errors";
import { env } from "./env";
import { getTicket, listProjects, listTickets, reply, searchTickets } from "./operations";
import { priorities } from "../domain/triage";
import { allowedProjectIds, isAction, type Principal } from "../domain/permissions";
import { errorOf } from "./api/router";
import { Reply } from "./api/reply";
import { agentGuide } from "./api/guide";
import { routes, type Route } from "./api/routes";
// The tools of the route table: every route that offers a tool becomes one, for
// a caller who holds its action in at least one project. A tool takes the path
// parameters, the query and the body of its route as one set of arguments, runs
// the same operation as REST and answers with the same JSON. A failure comes
// back as a result that names the field, so a client can correct its call.
function registerRouteTools(server: McpServer, principal: Principal) {
  for (const route of routes) {
    // A file is not a tool result; no binary route is offered.
    if (route.binary || !("tool" in route.mcp)) continue;
    if (!isAction(route.access) || allowedProjectIds(principal, route.access).length === 0)
      continue;
    const names = [...route.path.matchAll(/\{(\w+)\}/g)].map((found) => found[1] ?? "");
    const queryShape = route.query?.shape ?? {};
    const bodyShape = route.body instanceof z.ZodObject ? route.body.shape : {};
    const shape: z.ZodRawShape = {
      ...Object.fromEntries(
        names.map((name) => [name, name.endsWith("Id") ? z.uuid() : z.string()]),
      ),
      ...queryShape,
      ...(route.mcp.input ?? bodyShape),
    };
    server.registerTool(
      route.mcp.tool,
      { description: route.summary, inputSchema: shape },
      async (args: Record<string, unknown>) => {
        try {
          return await callRoute(route, principal, args, names, Object.keys(queryShape));
        } catch (error) {
          const { body } = errorOf(error);
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(body) }],
          };
        }
      },
    );
  }
}
async function callRoute(
  route: Route,
  principal: Principal,
  args: Record<string, unknown>,
  names: string[],
  queryNames: string[],
) {
  const text = (value: unknown) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  const params = Object.fromEntries(names.map((name) => [name, text(args[name])]));
  const query = new URLSearchParams();
  for (const name of queryNames) {
    const value = args[name];
    if (Array.isArray(value)) for (const entry of value) query.append(name, text(entry));
    else if (value !== undefined) query.set(name, text(value));
  }
  const input = Object.fromEntries(
    Object.entries(args).filter(([name]) => !names.includes(name) && !queryNames.includes(name)),
  );
  const outcome = await route.run({
    principal,
    params,
    query,
    input,
    request: new Request("http://mcp.invalid/"),
  });
  return textResult(outcome instanceof Reply ? outcome.value : outcome);
}
const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
export async function mcpRequest(request: Request): Promise<Response> {
  try {
    if (!request.headers.get("authorization")?.startsWith("Bearer "))
      throw new DomainError("unauthenticated", 401);
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(env().APP_URL).origin) throw new DomainError("forbidden", 403);
    const principal = await identify(request.headers);
    const server = new McpServer(
      { name: "aidesk", version: "0.1.0" },
      { instructions: agentGuide },
    );
    const result = (value: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
    });
    if (allowedProjectIds(principal).length)
      server.registerTool(
        "projects_list",
        { description: "List projects explicitly granted to this agent.", inputSchema: {} },
        async () => result(await listProjects(principal)),
      );
    if (allowedProjectIds(principal, "ticket.read").length) {
      server.registerTool(
        "tickets_list",
        {
          description: "List authorized tickets by oldest unanswered receipt.",
          inputSchema: {
            projectIds: z.array(z.uuid()).optional(),
            priority: z.enum(priorities).optional(),
            category: z.string().max(40).optional(),
          },
        },
        async ({ projectIds, priority, category }) =>
          result(await listTickets(principal, projectIds, undefined, { priority, category })),
      );
      server.registerTool(
        "tickets_search",
        {
          description:
            "Search authorized tickets by text in the subject, the requester or any message.",
          inputSchema: {
            query: z.string().min(2).max(100),
            projectIds: z.array(z.uuid()).optional(),
          },
        },
        async ({ query, projectIds }) => result(await searchTickets(principal, query, projectIds)),
      );
      server.registerTool(
        "tickets_get",
        {
          description: "Read an authorized ticket and its staff conversation.",
          inputSchema: { ticketId: z.uuid() },
        },
        async ({ ticketId }) => result(await getTicket(principal, ticketId)),
      );
    }
    if (
      allowedProjectIds(principal, "ticket.reply").length ||
      allowedProjectIds(principal, "ticket.note").length
    )
      server.registerTool(
        "tickets_reply",
        {
          description:
            "Queue a Markdown reply or record an internal note with revision and idempotency protection. Transport acceptance is asynchronous.",
          inputSchema: {
            ticketId: z.uuid(),
            markdown: z.string().min(1).max(100_000),
            internal: z.boolean().default(false),
            expectedRevision: z.number().int().positive(),
            idempotencyKey: z.uuid(),
            language: z.string(),
            resolve: z.boolean().default(false),
          },
        },
        async ({ ticketId, ...input }) => result(await reply(principal, ticketId, input)),
      );
    registerRouteTools(server, principal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      maxRequestBodySize: 200_000,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  } catch (error) {
    if (error instanceof DomainError)
      return Response.json({ error: error.code }, { status: error.status });
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
