import { ZodError } from "zod";
import { DomainError } from "../../../../server/errors";
import { getLimits } from "../../../../server/limits";
import { portalRules } from "../../../../domain/limits";
import { portalReply, type PortalFile } from "../../../../server/portal";
import { portalHost, portalOriginAllowed } from "../../../../server/portal-domains";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The portal's only write: a customer's reply, as JSON or, with files, as a form. It belongs to no
// session; the token is the credential, and the request must come from the application's own pages.
async function parts(
  request: Request,
): Promise<{ token: unknown; input: unknown; files: PortalFile[] }> {
  if (!(request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    const body = (await request.json()) as { token?: unknown } & Record<string, unknown>;
    const { token, ...input } = body;
    return { token, input, files: [] };
  }
  // A body far over what a reply may hold is not read.
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > portalRules(await getLimits()).bytes + 1024 * 1024)
    throw new DomainError("attachment_too_large", 413);
  const form = await request.formData();
  const files: PortalFile[] = [];
  for (const entry of form.getAll("files"))
    if (typeof entry !== "string")
      files.push({
        filename: entry.name,
        contentType: entry.type,
        content: Buffer.from(await entry.arrayBuffer()),
      });
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : undefined;
  };
  return {
    token: field("token"),
    input: { markdown: field("markdown"), idempotencyKey: field("idempotencyKey") },
    files,
  };
}
export async function POST(request: Request): Promise<Response> {
  try {
    // The request has to come from a page of the application: its own address or a name of a customer page.
    if (!(await portalOriginAllowed(request.headers.get("origin"))))
      throw new DomainError("forbidden", 403);
    const host = await portalHost(
      request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
    );
    const { token, input, files } = await parts(request);
    return Response.json(await portalReply(token, input, files, host), {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DomainError)
      return Response.json({ error: error.code }, { status: error.status });
    if (error instanceof ZodError || error instanceof SyntaxError || error instanceof TypeError)
      return Response.json({ error: "invalid_input" }, { status: 400 });
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
