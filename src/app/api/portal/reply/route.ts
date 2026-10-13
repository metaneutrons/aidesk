import { ZodError } from "zod";
import { DomainError } from "../../../../server/errors";
import { env } from "../../../../server/env";
import { portalReply } from "../../../../server/portal";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The portal's only write: a customer's reply. It belongs to no session; the
// token in the body is the credential, and the request must come from the
// application's own pages.
export async function POST(request: Request): Promise<Response> {
  try {
    if (request.headers.get("origin") !== new URL(env().APP_URL).origin)
      throw new DomainError("forbidden", 403);
    const body = (await request.json()) as { token?: unknown } & Record<string, unknown>;
    const { token, ...input } = body;
    return Response.json(await portalReply(token, input), {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DomainError)
      return Response.json({ error: error.code }, { status: error.status });
    if (error instanceof ZodError || error instanceof SyntaxError)
      return Response.json({ error: "invalid_input" }, { status: 400 });
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
