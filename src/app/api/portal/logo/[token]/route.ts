import { DomainError } from "../../../../../server/errors";
import { readPortalLogo } from "../../../../../server/branding";
import { portalHost } from "../../../../../server/portal-domains";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The logo of a project for the customer page of a link. The link is the credential, as for the page itself: a link
// that is unknown, expired, revoked or of another name gets the same 404. The answer is an image and nothing that a
// browser could run.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  try {
    const { token } = await params;
    const host = await portalHost(
      request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
    );
    const logo = await readPortalLogo(token, host);
    return new Response(new Uint8Array(logo.content), {
      headers: {
        "Content-Type": logo.type,
        "Content-Length": String(logo.content.length),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    if (error instanceof DomainError) return new Response(null, { status: 404 });
    throw error;
  }
}
