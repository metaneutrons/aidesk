// Development-only SSO bootstrap: registers the local Keycloak realm as one
// OIDC and one SAML provider through the Better Auth API (as the development
// owner), marks the reserved .test domains verified, which DNS cannot do
// locally, and provisions the operators that may sign in through them.
// Production providers are registered by an owner and verified through DNS.
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { auth } from "../src/server/auth";
import { db } from "../src/server/db";
import { memberships, projects, ssoProvider, user } from "../src/server/db/schema";
import { actions, type Action } from "../src/domain/permissions";
const oidcProvider = "keycloak-oidc";
const samlProvider = "keycloak-saml";
const operators: { email: string; name: string; project: string; grant: readonly Action[] }[] = [
  { email: "alice@oidc.aidesk.test", name: "Alice OIDC", project: "orbit", grant: actions },
  {
    email: "bob@saml.aidesk.test",
    name: "Bob SAML",
    project: "harbor",
    grant: ["project.read", "ticket.read", "ticket.note"],
  },
];
function sessionCookie(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
export async function ensureDevSso(): Promise<void> {
  const secret = process.env.DEV_SSO_OIDC_CLIENT_SECRET;
  const issuer = process.env.DEV_SSO_ISSUER;
  const internal = process.env.DEV_SSO_INTERNAL_URL;
  const ownerEmail = process.env.DEV_OWNER_EMAIL;
  const ownerPassword = process.env.DEV_OWNER_PASSWORD;
  if (!secret || !issuer || !internal || !ownerEmail || !ownerPassword) {
    console.log("Development SSO is not configured; skipped.");
    return;
  }
  const existing = await db()
    .select({ providerId: ssoProvider.providerId })
    .from(ssoProvider)
    .where(inArray(ssoProvider.providerId, [oidcProvider, samlProvider]));
  const registered = new Set(existing.map((row) => row.providerId));
  if (registered.size < 2) {
    const signIn = await auth().api.signInEmail({
      body: { email: ownerEmail, password: ownerPassword },
      asResponse: true,
    });
    if (!signIn.ok) throw new Error("Development owner sign-in for SSO bootstrap failed.");
    const headers = new Headers({ cookie: sessionCookie(signIn) });
    try {
      if (!registered.has(oidcProvider))
        await auth().api.registerSSOProvider({
          headers,
          body: {
            providerId: oidcProvider,
            issuer,
            domain: "oidc.aidesk.test",
            oidcConfig: {
              clientId: "aidesk-dev-oidc",
              clientSecret: secret,
              discoveryEndpoint: `${internal}/.well-known/openid-configuration`,
              scopes: ["openid", "email", "profile"],
              pkce: true,
            },
          },
        });
      if (!registered.has(samlProvider)) {
        // Keycloak's realm descriptor always declares WantAuthnRequestsSigned,
        // which conflicts with unsigned requests when passed as metadata XML.
        // Use its entity ID and signing certificate instead.
        const descriptor = await fetch(`${internal}/protocol/saml/descriptor`);
        if (!descriptor.ok) throw new Error("Keycloak SAML metadata is unavailable.");
        const xml = await descriptor.text();
        const entityID = /entityID="([^"]+)"/.exec(xml)?.[1];
        const certificate = /<(?:ds:)?X509Certificate>([^<]+)</.exec(xml)?.[1];
        if (!entityID || !certificate) throw new Error("Keycloak SAML metadata is incomplete.");
        await auth().api.registerSSOProvider({
          headers,
          body: {
            providerId: samlProvider,
            issuer,
            domain: "saml.aidesk.test",
            samlConfig: {
              entryPoint: `${issuer}/protocol/saml`,
              idpMetadata: {
                entityID,
                cert: `-----BEGIN CERTIFICATE-----\n${certificate}\n-----END CERTIFICATE-----`,
                singleSignOnService: [
                  {
                    Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
                    Location: `${issuer}/protocol/saml`,
                  },
                ],
              },
              spMetadata: { entityID: "aidesk-dev-saml" },
              wantAssertionsSigned: true,
              identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
              callbackUrl: "/",
              mapping: {
                email: "email",
                name: "displayName",
                firstName: "firstName",
                lastName: "lastName",
              },
            },
          },
        });
      }
    } finally {
      await auth().api.signOut({ headers });
    }
  }
  await db()
    .update(ssoProvider)
    .set({ domainVerified: true })
    .where(inArray(ssoProvider.providerId, [oidcProvider, samlProvider]));
  for (const operator of operators) {
    const [present] = await db().select().from(user).where(eq(user.email, operator.email));
    if (present) continue;
    const [project] = await db()
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, operator.project));
    if (!project) continue;
    const id = randomUUID();
    await db().transaction(async (tx) => {
      await tx
        .insert(user)
        .values({ id, name: operator.name, email: operator.email, emailVerified: true });
      await tx
        .insert(memberships)
        .values({ userId: id, projectId: project.id, actions: [...operator.grant] });
    });
  }
  console.log("Development SSO providers and operators are ready.");
}
