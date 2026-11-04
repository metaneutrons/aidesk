import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { audit, ssoProvider, ssoProviderProvisioning, ssoProviderState } from "./db/schema";
// What the plugin of the sign-in does when it is about to create a user: it has one switch for the installation
// (`disableImplicitSignUp`), and aidesk leaves it open and decides here, per provider. A user is created only when the
// sign-in came back through the address of one provider, that provider is switched on, its domain is proved, an owner
// allowed it to create operators, and the address of the person is in that domain. Every other creation of a user
// through the plugin is refused; operators that an owner adds, and invitations, are written by the product itself.
type EndpointContext = { path?: string; params?: unknown } | null | undefined;
// The routes of the plugin that answer a sign-in and name the provider.
const routes = ["/sso/callback/", "/sso/saml2/sp/acs/", "/sso/saml2/callback/"];
export function providerOfSignIn(context: EndpointContext): string | null {
  const path = context?.path;
  if (typeof path !== "string" || !routes.some((route) => path.startsWith(route))) return null;
  const params = context?.params;
  const named =
    typeof params === "object" && params !== null && "providerId" in params
      ? params.providerId
      : undefined;
  return typeof named === "string" && named !== "" ? named : null;
}
// The address is in the domain of the provider, or in one below it, as the plugin reads it when it links an account.
export function inProviderDomain(email: string, domain: string): boolean {
  const host = email.split("@")[1]?.toLowerCase();
  const wanted = domain.toLowerCase();
  return host !== undefined && host !== "" && (host === wanted || host.endsWith(`.${wanted}`));
}
const refused = () =>
  new APIError("FORBIDDEN", { code: "SSO_SIGNUP_DISABLED", message: "signup disabled" });
// Before the user is created: throws the refusal, or returns the provider that creates the operator.
export async function assertSsoProvisioning(
  context: EndpointContext,
  email: string,
): Promise<string> {
  const providerId = providerOfSignIn(context);
  if (providerId === null) throw refused();
  const [row] = await db().select().from(ssoProvider).where(eq(ssoProvider.providerId, providerId));
  const [allowed] = await db()
    .select({ providerId: ssoProviderProvisioning.providerId })
    .from(ssoProviderProvisioning)
    .where(eq(ssoProviderProvisioning.providerId, providerId));
  const [off] = await db()
    .select({ providerId: ssoProviderState.providerId })
    .from(ssoProviderState)
    .where(eq(ssoProviderState.providerId, providerId));
  if (
    !row ||
    !allowed ||
    off ||
    row.domainVerified !== true ||
    !inProviderDomain(email, row.domain)
  )
    throw refused();
  return providerId;
}
// After the user exists: the creation is an entry of the audit, before the entry of the sign-in that follows it.
export async function auditSsoProvisioned(userId: string, providerId: string): Promise<void> {
  await db()
    .insert(audit)
    .values({ actorId: userId, action: "operator.sso_provisioned", detail: { providerId } });
}
