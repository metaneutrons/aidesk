import { db } from "./db";
import { audit } from "./db/schema";
// An operator who signed in through an identity provider is an entry of the audit with the provider when the route
// that answered names it (the callback of one provider and its SAML answer do; the shared callback does not).
export async function auditSsoSignIn(userId: string, providerId?: string): Promise<void> {
  await db()
    .insert(audit)
    .values({
      actorId: userId,
      action: "operator.sso_sign_in",
      detail: providerId ? { providerId } : {},
    });
}
