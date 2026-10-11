import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { identify } from "./principal";
import { DomainError } from "./errors";
import { env } from "./env";
import { getTicket, listProjects, listTickets, reply } from "./operations";
import { allowedProjectIds } from "../domain/permissions";
export async function mcpRequest(request: Request): Promise<Response> {
  try {
    if (!request.headers.get("authorization")?.startsWith("Bearer "))
      throw new DomainError("unauthenticated", 401);
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(env().APP_URL).origin) throw new DomainError("forbidden", 403);
    const principal = await identify(request.headers);
    const server = new McpServer({ name: "aidesk", version: "0.1.0" });
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
          inputSchema: { projectIds: z.array(z.uuid()).optional() },
        },
        async ({ projectIds }) => result(await listTickets(principal, projectIds)),
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
