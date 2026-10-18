import { NextResponse, type NextRequest } from "next/server";
import { hostOf, portalHostMayServe } from "./domain/portal-domains";
import { applicationHost, portalHost } from "./server/portal-domains";
// A name that a project or the installation has proved for the customer page serves that page and nothing else: not the desk, not
// the API, not the sign-in. Any other path on such a name is not found. The address of the application and every
// name that is not a customer page (the addresses of the platform, a machine on its own port) are left as they
// were. If the lookup of the names fails, a request on a name other than the application's is not answered
// (503), because it could be a name of a customer page and the rule could not be applied.
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const host = hostOf(request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
  if (!host || host === applicationHost()) return NextResponse.next();
  let found: Awaited<ReturnType<typeof portalHost>>;
  try {
    found = await portalHost(host);
  } catch {
    return new NextResponse(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (found === null || portalHostMayServe(request.nextUrl.pathname)) return NextResponse.next();
  return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
