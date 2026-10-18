import { X509Certificate } from "node:crypto";
import { APIError } from "better-auth/api";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Principal } from "../domain/permissions";
import { domainRecord, ssoRegisterInput, ssoUpdateInput, ssoDeleteInput } from "../domain/sso";
import { auth } from "./auth";
import { db } from "./db";
import { account, audit, ssoProvider, ssoProviderState, user } from "./db/schema";
import { env } from "./env";
import { DomainError } from "./errors";
import { checkHost, developmentStack } from "./host-guard";
// The identity providers of the installation, for its owner: registered, listed, edited, proved by their domain,
// tested, switched off and on, and deleted. The plugin of the sign-in does the protocol; this is the layer that the
// settings and the API use, with what the plugin does not have (a switch, a test, who is linked) and without what it
// hands out (the register answer holds the secret of the client, which never leaves here). Only an owner may use it.
const providerKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,43}$/);
function owner(principal: Principal): void {
  if (principal.kind !== "human" || !principal.active || !principal.owner)
    throw new DomainError("forbidden", 403);
}
type Config = Record<string, unknown>;
function parse(text: string | null): Config {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Config) : {};
  } catch {
    return {};
  }
}
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
async function view(row: typeof ssoProvider.$inferSelect) {
  const oidc = parse(row.oidcConfig);
  const saml = parse(row.samlConfig);
  const isOidc = row.oidcConfig !== null;
  const [state] = await db()
    .select()
    .from(ssoProviderState)
    .where(eq(ssoProviderState.providerId, row.providerId));
  const linked = await db()
    .select({ id: user.id, name: user.name, email: user.email, active: user.active })
    .from(account)
    .innerJoin(user, eq(user.id, account.userId))
    .where(eq(account.providerId, row.providerId))
    .orderBy(asc(user.name));
  const origin = new URL(env().APP_URL).origin;
  const clientId = text(oidc.clientId);
  return {
    providerId: row.providerId,
    type: isOidc ? ("oidc" as const) : ("saml" as const),
    issuer: row.issuer,
    domain: row.domain,
    domainVerified: row.domainVerified === true,
    disabled: state !== undefined,
    disabledAt: state?.disabledAt ?? null,
    clientIdLastFour: clientId ? clientId.slice(-4) : null,
    // What the provider has to be given: the address that it calls back, or the metadata of this side.
    callback: isOidc
      ? `${origin}/api/auth/sso/callback/${row.providerId}`
      : `${origin}/api/auth/sso/saml2/sp/acs/${row.providerId}`,
    metadata: isOidc
      ? null
      : `${origin}/api/auth/sso/saml2/sp/metadata?providerId=${row.providerId}`,
    samlAudience: isOidc ? null : text((saml.spMetadata as Config | undefined)?.entityID),
    operators: linked,
  };
}
const find = async (providerId: string) => {
  const [row] = await db()
    .select()
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, providerKey.parse(providerId)));
  if (!row) throw new DomainError("not_found", 404);
  return row;
};
async function record(principal: Principal, action: string, providerId: string, detail: Config) {
  await db()
    .insert(audit)
    .values({
      actorId: principal.id,
      action: `sso_provider.${action}`,
      targetId: providerId,
      detail,
    });
}
// A refusal of the plugin, as an error of the product.
function refused(error: unknown): never {
  if (error instanceof APIError) {
    const status = error.statusCode;
    if (status === 404) throw new DomainError("not_found", 404);
    if (status === 409) throw new DomainError("conflict", 409);
    throw new DomainError("invalid_input", 400);
  }
  throw error;
}
export async function listSsoProviders(principal: Principal) {
  owner(principal);
  const rows = await db().select().from(ssoProvider).orderBy(asc(ssoProvider.providerId));
  return Promise.all(rows.map(view));
}
export async function registerSsoProvider(principal: Principal, headers: Headers, input: unknown) {
  owner(principal);
  const values = ssoRegisterInput.parse(input);
  const origin = new URL(env().APP_URL).origin;
  const body = values.oidc
    ? {
        providerId: values.providerId,
        issuer: values.issuer,
        domain: values.domain,
        oidcConfig: {
          clientId: values.oidc.clientId,
          clientSecret: values.oidc.clientSecret,
          discoveryEndpoint:
            values.oidc.discoveryEndpoint ??
            `${values.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
          scopes: values.oidc.scopes ?? ["openid", "email", "profile"],
          pkce: values.oidc.pkce ?? true,
        },
      }
    : {
        providerId: values.providerId,
        issuer: values.issuer,
        domain: values.domain,
        samlConfig: {
          entryPoint: values.saml?.entryPoint ?? "",
          idpMetadata: {
            entityID: values.issuer,
            cert: values.saml?.cert ?? "",
            singleSignOnService: [
              {
                Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
                Location: values.saml?.entryPoint ?? "",
              },
            ],
          },
          spMetadata: {
            entityID:
              values.saml?.audience ??
              `${origin}/api/auth/sso/saml2/sp/metadata?providerId=${values.providerId}`,
          },
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
      };
  let made: { domainVerificationToken?: string };
  try {
    made = await auth().api.registerSSOProvider({ headers, body: body as never });
  } catch (error) {
    refused(error);
  }
  await record(principal, "register", values.providerId, {
    type: values.oidc ? "oidc" : "saml",
    domain: values.domain,
    issuer: values.issuer,
  });
  const row = await find(values.providerId);
  // The answer of the plugin holds the secret of the client; only the token for the proof of the domain is taken from it.
  const token = made.domainVerificationToken ?? "";
  return {
    ...(await view(row)),
    domainRecord: token ? domainRecord(values.providerId, values.domain, token) : null,
  };
}
export async function updateSsoProvider(
  principal: Principal,
  headers: Headers,
  providerId: string,
  input: unknown,
) {
  owner(principal);
  const row = await find(providerId);
  const values = ssoUpdateInput.parse(input);
  if ((values.clientSecret !== undefined || values.scopes !== undefined) && row.oidcConfig === null)
    throw new DomainError("invalid_input", 400);
  const body: Config = { providerId: row.providerId };
  if (values.domain !== undefined) body.domain = values.domain;
  if (values.clientSecret !== undefined || values.scopes !== undefined)
    body.oidcConfig = {
      ...(values.clientSecret !== undefined ? { clientSecret: values.clientSecret } : {}),
      ...(values.scopes !== undefined ? { scopes: values.scopes } : {}),
    };
  try {
    await auth().api.updateSSOProvider({ headers, body: body as never });
  } catch (error) {
    refused(error);
  }
  await record(principal, "update", row.providerId, {
    // What changed, never the secret itself.
    changed: Object.keys(values).filter((key) => values[key as keyof typeof values] !== undefined),
    ...(values.domain !== undefined ? { domain: values.domain, from: row.domain } : {}),
  });
  return view(await find(row.providerId));
}
export async function requestSsoDomainRecord(
  principal: Principal,
  headers: Headers,
  providerId: string,
) {
  owner(principal);
  const row = await find(providerId);
  try {
    const answer = (await auth().api.requestDomainVerification({
      headers,
      body: { providerId: row.providerId },
    })) as { domainVerificationToken?: string };
    return {
      providerId: row.providerId,
      domainVerified: row.domainVerified === true,
      record: answer.domainVerificationToken
        ? domainRecord(row.providerId, row.domain, answer.domainVerificationToken)
        : null,
    };
  } catch (error) {
    if (error instanceof APIError && error.statusCode === 409)
      return { providerId: row.providerId, domainVerified: true, record: null };
    refused(error);
  }
}
export type SsoVerifyResult = "verified" | "record_missing" | "request_first" | "already_verified";
export async function verifySsoDomain(principal: Principal, headers: Headers, providerId: string) {
  owner(principal);
  const row = await find(providerId);
  const [state] = await db()
    .select()
    .from(ssoProviderState)
    .where(eq(ssoProviderState.providerId, row.providerId));
  // A provider that is switched off is not made valid again by a proof: it is switched on.
  if (state) throw new DomainError("conflict", 409);
  let result: SsoVerifyResult = "verified";
  try {
    await auth().api.verifyDomain({ headers, body: { providerId: row.providerId } });
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    const code = (error.body as { code?: string } | undefined)?.code;
    const status = error.statusCode;
    if (status === 409 || code === "DOMAIN_VERIFIED") result = "already_verified";
    else if (status === 404 || code === "NO_PENDING_VERIFICATION") result = "request_first";
    else if (status === 502 || code === "DOMAIN_VERIFICATION_FAILED") result = "record_missing";
    else throw new DomainError("invalid_input", 400);
  }
  if (result === "verified")
    await record(principal, "verify_domain", row.providerId, { domain: row.domain });
  return { ...(await view(await find(row.providerId))), result };
}
export async function disableSsoProvider(principal: Principal, providerId: string) {
  owner(principal);
  const row = await find(providerId);
  await db().transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(ssoProviderState)
      .where(eq(ssoProviderState.providerId, row.providerId));
    if (state) return;
    await tx.insert(ssoProviderState).values({
      providerId: row.providerId,
      disabledBy: principal.id,
      verifiedBefore: row.domainVerified === true,
    });
    // The plugin refuses sign-in, the callback and the answer of a provider whose domain is not verified.
    await tx
      .update(ssoProvider)
      .set({ domainVerified: false })
      .where(eq(ssoProvider.providerId, row.providerId));
    await tx.insert(audit).values({
      actorId: principal.id,
      action: "sso_provider.disable",
      targetId: row.providerId,
      detail: { domain: row.domain },
    });
  });
  return view(await find(row.providerId));
}
export async function enableSsoProvider(principal: Principal, providerId: string) {
  owner(principal);
  const row = await find(providerId);
  await db().transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(ssoProviderState)
      .where(eq(ssoProviderState.providerId, row.providerId));
    if (!state) return;
    await tx.delete(ssoProviderState).where(eq(ssoProviderState.providerId, row.providerId));
    // What was verified before is verified again; a domain that was never proved has to be proved.
    await tx
      .update(ssoProvider)
      .set({ domainVerified: state.verifiedBefore })
      .where(eq(ssoProvider.providerId, row.providerId));
    await tx.insert(audit).values({
      actorId: principal.id,
      action: "sso_provider.enable",
      targetId: row.providerId,
      detail: { domain: row.domain, verified: state.verifiedBefore },
    });
  });
  return view(await find(row.providerId));
}
export async function deleteSsoProvider(
  principal: Principal,
  headers: Headers,
  providerId: string,
  input: unknown,
) {
  owner(principal);
  const row = await find(providerId);
  const values = ssoDeleteInput.parse(input);
  // The identifier is typed, because the operators who signed in through it lose that way in.
  if (values.confirm !== row.providerId) throw new DomainError("invalid_input", 400);
  const linked = await db()
    .select({ id: account.userId })
    .from(account)
    .where(eq(account.providerId, row.providerId));
  await record(principal, "delete", row.providerId, {
    type: row.oidcConfig !== null ? "oidc" : "saml",
    domain: row.domain,
    operators: linked.length,
  });
  try {
    await auth().api.deleteSSOProvider({ headers, body: { providerId: row.providerId } });
  } catch (error) {
    refused(error);
  }
  await db().delete(ssoProviderState).where(eq(ssoProviderState.providerId, row.providerId));
  return { deleted: true, operators: linked.length };
}
// A look at what a provider needs to work, without signing anybody in: its documents can be read, they say what
// the configuration says, and the certificate is not about to end.
export interface SsoCheck {
  name: string;
  ok: boolean;
  detail: string;
}
const waitMs = 8_000;
async function readable(url: string): Promise<Response> {
  const target = new URL(url);
  if (!developmentStack()) {
    if (target.protocol !== "https:") throw new Error("not_https");
    const verdict = await checkHost(target.hostname);
    if (verdict !== "allowed") throw new Error(verdict);
  }
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(waitMs) });
}
const short = (value: unknown) =>
  String(value instanceof Error ? value.message : value).slice(0, 160);
async function jsonOf(url: string): Promise<Config> {
  const response = await readable(url);
  if (!response.ok) throw new Error(`answer ${String(response.status)}`);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null) throw new Error("not an object");
  return value as Config;
}
export async function testSsoProvider(principal: Principal, providerId: string) {
  owner(principal);
  const row = await find(providerId);
  const checks: SsoCheck[] = [];
  const check = async (name: string, run: () => Promise<string> | string) => {
    try {
      checks.push({ name, ok: true, detail: await run() });
    } catch (error) {
      checks.push({ name, ok: false, detail: short(error) });
    }
  };
  checks.push({
    name: "domain",
    ok: row.domainVerified === true,
    detail: row.domainVerified === true ? "verified" : "not verified (or switched off)",
  });
  if (row.oidcConfig !== null) {
    const config = parse(row.oidcConfig);
    const discovery =
      text(config.discoveryEndpoint) ??
      `${row.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    let document: Config = {};
    await check("discovery", async () => {
      document = await jsonOf(discovery);
      return "the document of the provider was read";
    });
    await check("issuer", () => {
      const said = text(document.issuer);
      if (said === null) throw new Error("the document names no issuer");
      if (said.replace(/\/+$/, "") !== row.issuer.replace(/\/+$/, ""))
        throw new Error("the provider names another issuer than the one registered");
      return "the issuer matches";
    });
    await check("endpoints", () => {
      for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"])
        if (!text(document[key])) throw new Error(`the document has no ${key}`);
      return "authorization, token and keys are named";
    });
    await check("keys", async () => {
      const keys = (await jsonOf(text(document.jwks_uri) ?? "")).keys;
      if (!Array.isArray(keys) || keys.length === 0) throw new Error("no signing key");
      return `${String(keys.length)} signing key(s)`;
    });
  } else {
    const config = parse(row.samlConfig);
    const idp = (config.idpMetadata ?? {}) as Config;
    await check("certificate", () => {
      const pem = text(idp.cert) ?? text(config.cert);
      if (!pem) throw new Error("no certificate is registered");
      const certificate = new X509Certificate(pem);
      const ends = new Date(certificate.validTo);
      if (ends.getTime() < Date.now())
        throw new Error(`the certificate ended on ${ends.toISOString().slice(0, 10)}`);
      const days = Math.floor((ends.getTime() - Date.now()) / 86_400_000);
      if (days < 30) throw new Error(`the certificate ends in ${String(days)} days`);
      return `valid until ${ends.toISOString().slice(0, 10)}`;
    });
    await check("entry point", async () => {
      const entry = text(config.entryPoint);
      if (!entry) throw new Error("no entry point is registered");
      const response = await readable(entry);
      if (response.status >= 500) throw new Error(`answer ${String(response.status)}`);
      return `the entry point answers (${String(response.status)})`;
    });
  }
  const ok = checks.every((entry) => entry.ok);
  await record(principal, "test", row.providerId, {
    ok,
    failed: checks.filter((entry) => !entry.ok).map((entry) => entry.name),
  });
  return { providerId: row.providerId, ok, checks };
}
// For the guard of sign-in and for tests: whether a provider is switched off.
export async function ssoProviderDisabled(providerId: string): Promise<boolean> {
  const [state] = await db()
    .select({ id: ssoProviderState.providerId })
    .from(ssoProviderState)
    .where(and(eq(ssoProviderState.providerId, providerId)));
  return state !== undefined;
}
