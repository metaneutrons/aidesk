import { ZodError } from "zod";
import { identify, requireMutationOrigin } from "../../../../server/principal";
import {
  createOperator,
  createProject,
  getAttachment,
  getOriginal,
  getTicket,
  issueAgentToken,
  listAgentTokens,
  listOperators,
  listProjects,
  listTickets,
  reply,
  revokeAgentToken,
  setLocale,
  setOperatorActive,
  setOperatorGrant,
  setProjectSettings,
} from "../../../../server/operations";
import { DomainError } from "../../../../server/errors";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Attachments are always downloaded, never rendered by the browser: the stored
// type is not trusted, so the response is opaque, sandboxed and not cached.
function download(file: { filename: string; content: Buffer }): Response {
  const ascii = file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(new Uint8Array(file.content), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.content.length),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}
async function dispatch(request: Request): Promise<Response> {
  try {
    const principal = await identify(request.headers);
    const url = new URL(request.url);
    const segments = url.pathname.slice("/api/v1/".length).split("/");
    const [resource, identifier, operation] = segments;
    if (request.method === "GET") {
      if (resource === "projects" && segments.length === 1)
        return Response.json(await listProjects(principal));
      if (resource === "operators" && segments.length === 1)
        return Response.json(await listOperators(principal));
      if (resource === "projects" && identifier && operation === "agents" && segments.length === 3)
        return Response.json(await listAgentTokens(principal, identifier));
      if (resource === "tickets" && identifier && segments.length === 2)
        return Response.json(await getTicket(principal, identifier));
      if (
        resource === "messages" &&
        identifier &&
        operation === "original" &&
        segments.length === 3
      )
        return download(await getOriginal(principal, identifier));
      if (resource === "attachments" && identifier && segments.length === 2)
        return download(await getAttachment(principal, identifier));
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
      if (resource === "operators" && segments.length === 1)
        return Response.json(await createOperator(principal, input), { status: 201 });
      if (resource === "operators" && identifier && operation === "grants" && segments.length === 3)
        return Response.json(await setOperatorGrant(principal, identifier, input));
      if (resource === "operators" && identifier && operation === "active" && segments.length === 3)
        return Response.json(await setOperatorActive(principal, identifier, input));
      if (resource === "projects" && identifier && operation === "agents" && segments.length === 3)
        return Response.json(await issueAgentToken(principal, identifier, input), { status: 201 });
      if (
        resource === "projects" &&
        identifier &&
        operation === "settings" &&
        segments.length === 3
      )
        return Response.json(await setProjectSettings(principal, identifier, input));
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
