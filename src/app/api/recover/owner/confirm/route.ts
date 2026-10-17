import { ZodError } from "zod";
import { DomainError } from "../../../../../server/errors";
import { confirmOwnerRecovery } from "../../../../../server/owner";
import { requireMutationOrigin } from "../../../../../server/principal";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  try {
    requireMutationOrigin(request);
    return Response.json(await confirmOwnerRecovery(await request.json()));
  } catch (error) {
    if (error instanceof DomainError)
      return Response.json({ error: error.code }, { status: error.status });
    if (error instanceof ZodError || error instanceof SyntaxError)
      return Response.json({ error: "invalid_input" }, { status: 400 });
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
