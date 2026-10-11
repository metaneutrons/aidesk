import { auth } from "../../../../server/auth";
import { identify, requireMutationOrigin } from "../../../../server/principal";
import { DomainError } from "../../../../server/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const managementPaths = new Set([
  "/sso/register",
  "/sso/providers",
  "/sso/get-provider",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
]);
async function handle(request: Request): Promise<Response> {
  try {
    const path = new URL(request.url).pathname.slice("/api/auth".length);
    if (managementPaths.has(path)) {
      const principal = await identify(request.headers);
      if (principal.kind !== "human" || !principal.owner) throw new DomainError("forbidden", 403);
      if (request.method !== "GET") requireMutationOrigin(request);
    }
    return await auth().handler(request);
  } catch (error) {
    if (error instanceof DomainError)
      return Response.json({ error: error.code }, { status: error.status });
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
export const GET = handle;
export const POST = handle;
