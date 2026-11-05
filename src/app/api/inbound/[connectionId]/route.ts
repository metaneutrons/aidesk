import { forwardedAddress, receivePush } from "../../../../server/inbound-push";
// Mail handed over by the Email Worker of Cloudflare or by a program with the token of an inbound
// connection of kind push. The documentation of the contract is in docs/development.md ("HTTPS inbound").
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// The body is read in pieces, so that a message over the limit is refused without being held in memory.
async function readLimited(request: Request, limit: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("inbound_size");
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("inbound_size");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const { connectionId } = await context.params;
  const result = await receivePush({
    connectionId,
    authorization: request.headers.get("authorization"),
    recipient: request.headers.get("x-aidesk-recipient"),
    deliveryId: request.headers.get("x-aidesk-delivery-id"),
    sourceAddress: forwardedAddress(request.headers.get("x-forwarded-for")),
    readBody: (limit) => readLimited(request, limit),
  });
  return Response.json(result.body, { status: result.status });
}
