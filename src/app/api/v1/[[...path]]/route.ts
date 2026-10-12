import { ZodError } from "zod";
import { identify, requireMutationOrigin } from "../../../../server/principal";
import {
  createProject,
  getTicket,
  issueAgentToken,
  listAgentTokens,
  listProjects,
  listTickets,
  reply,
  revokeAgentToken,
  setLocale,
} from "../../../../server/operations";
import { DomainError } from "../../../../server/errors";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
async function dispatch(request: Request): Promise<Response> {
  try {
    const principal = await identify(request.headers);
    const url = new URL(request.url);
    const segments = url.pathname.slice("/api/v1/".length).split("/");
    const [resource, identifier, operation] = segments;
    if (request.method === "GET") {
      if (resource === "projects" && segments.length === 1)
        return Response.json(await listProjects(principal));
      if (resource === "projects" && identifier && operation === "agents" && segments.length === 3)
        return Response.json(await listAgentTokens(principal, identifier));
      if (resource === "tickets" && identifier && segments.length === 2)
        return Response.json(await getTicket(principal, identifier));
      if (resource === "tickets" && segments.length === 1)
        return Response.json(await listTickets(principal, url.searchParams.getAll("project")));
    }
    if (request.method === "POST") {
      requireMutationOrigin(request);
      // Commands such as revoke carry no body.
      const text = await request.text();
      const input: unknown = text ? JSON.parse(text) : {};
      if (resource === "projects" && segments.length === 1)
        return Response.json(await createProject(principal, input), { status: 201 });
      if (resource === "projects" && identifier && operation === "agents" && segments.length === 3)
        return Response.json(await issueAgentToken(principal, identifier, input), { status: 201 });
      if (resource === "agents" && identifier && operation === "revoke" && segments.length === 3)
        return Response.json(await revokeAgentToken(principal, identifier));
      if (resource === "tickets" && identifier && operation === "reply" && segments.length === 3)
        return Response.json(await reply(principal, identifier, input), { status: 202 });
      if (resource === "me" && identifier === "locale" && segments.length === 2) {
        await setLocale(principal, input);
        return Response.json({ updated: true });
      }
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof DomainError)
      return Response.json({ error: error.code }, { status: error.status });
    if (error instanceof ZodError || error instanceof SyntaxError)
      return Response.json({ error: "invalid_input" }, { status: 400 });
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
export const GET = dispatch;
export const POST = dispatch;
