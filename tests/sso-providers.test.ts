import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ZodError } from "zod";
import { createRequire, syncBuiltinESMExports } from "node:module";
// What the DNS answers for a name. The plugin of the sign-in asks `node:dns/promises` itself, from a package that the
// tests do not transform, so a mock of the module does not reach it; the function of the module is replaced instead,
// which the plugin sees after the exports of the built-in module are synchronised.
const dns = { txt: new Map<string, string[][] | "fail">() };
const dnsModule = createRequire(import.meta.url)("node:dns/promises") as {
  resolveTxt: (name: string) => Promise<string[][]>;
};
const realResolveTxt = dnsModule.resolveTxt;
const fakeResolveTxt = (name: string) => {
  const found = dns.txt.get(name);
  if (found === "fail")
    return Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
  if (!found) return Promise.reject(Object.assign(new Error("nx"), { code: "ENODATA" }));
  return Promise.resolve(found);
};
import { db } from "../src/server/db";
import {
  account,
  audit,
  session,
  ssoProvider,
  ssoProviderState,
  verification,
  user,
} from "../src/server/db/schema";
import { auth } from "../src/server/auth";
import {
  deleteSsoProvider,
  disableSsoProvider,
  enableSsoProvider,
  listSsoProviders,
  registerSsoProvider,
  requestSsoDomainRecord,
  testSsoProvider,
  updateSsoProvider,
  verifySsoDomain,
} from "../src/server/sso-providers";
import { auditSsoSignIn } from "../src/server/sso-audit";
import { DomainError } from "../src/server/errors";
import { certificates } from "./support/certificates";
import type { Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);

// The owner is a principal that is built here: the tests of the setup of the owner remove every owner row. The
// session that the plugin needs belongs to an ordinary row, which is the one that registers the provider.
const owner: Principal = {
  id: `sso-owner-${run}`,
  kind: "human",
  active: true,
  owner: true,
  grants: [],
};
const operator: Principal = { ...owner, id: `sso-operator-${run}`, owner: false };
const token: Principal = { ...owner, id: `sso-token-${run}`, kind: "agent" };
const userIds = { registrant: `sso-registrant-${run}`, linked: `sso-linked-${run}` };
const provider = (label: string) => `t${run}-${label}`.slice(0, 44);
const outcome = async (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) =>
      error instanceof DomainError ? error.code : error instanceof ZodError ? "invalid" : "other",
  );
let headers = new Headers();
const registrants: string[] = [];
// The plugin lets one person register ten providers, so each group of tests registers as another person.
async function newRegistrant(label: string): Promise<void> {
  const id = `sso-reg-${label}-${run}`;
  registrants.push(id);
  await db()
    .insert(user)
    .values({ id, name: label, email: `${id}@example.test` });
  headers = await sessionHeaders(id);
}
async function sessionHeaders(userId: string): Promise<Headers> {
  const context = await auth().$context;
  const started = await context.internalAdapter.createSession(userId);
  const signature = createHmac("sha256", context.secret).update(started.token).digest("base64");
  const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${started.token}.${signature}`)}`;
  return new Headers({
    cookie,
    origin: new URL(process.env.APP_URL ?? "http://localhost:3000").origin,
  });
}
// A provider of the other side, as far as a test needs it: the document and the keys.
let idp: Server;
let idpUrl = "";
let idpIssuer: string | null = null;
let idpKeys: unknown = [{ kty: "RSA", kid: "k1", n: "AQAB", e: "AQAB" }];
// Keys of the discovery document that the provider of a test leaves out.
let idpOmit: string[] = [];
beforeAll(async () => {
  dnsModule.resolveTxt = fakeResolveTxt;
  syncBuiltinESMExports();
  await migrate(db(), { migrationsFolder: "drizzle" });
  idp = createServer((request, response) => {
    const base = idpUrl;
    if (request.url === "/.well-known/openid-configuration") {
      response.setHeader("content-type", "application/json");
      const document: Record<string, unknown> = {
        issuer: idpIssuer ?? base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        userinfo_endpoint: `${base}/userinfo`,
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      };
      response.end(
        JSON.stringify(
          Object.fromEntries(Object.entries(document).filter(([key]) => !idpOmit.includes(key))),
        ),
      );
    } else if (request.url === "/broken") {
      response.statusCode = 503;
      response.end();
    } else if (request.url === "/jwks") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: idpKeys }));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  idpUrl = `http://127.0.0.1:${String((idp.address() as AddressInfo).port)}`;
  // The plugin refuses a provider whose documents are on a private address unless its origin is trusted; the
  // list is read when the sign-in is set up, which happens at the first use, so it is set before that.
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = idpUrl;
  await db()
    .insert(user)
    .values([
      { id: userIds.registrant, name: "Registrant", email: `${userIds.registrant}@example.test` },
      { id: userIds.linked, name: "Linked Person", email: `${userIds.linked}@example.test` },
    ]);
  headers = await sessionHeaders(userIds.registrant);
});
afterAll(async () => {
  if (registrants.length) {
    await db().delete(session).where(inArray(session.userId, registrants));
    await db().delete(user).where(inArray(user.id, registrants));
  }
});
afterEach(() => {
  dns.txt.clear();
  idpIssuer = null;
  idpKeys = [{ kty: "RSA", kid: "k1", n: "AQAB", e: "AQAB" }];
  idpOmit = [];
});
afterAll(async () => {
  dnsModule.resolveTxt = realResolveTxt;
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  await new Promise((resolve) => idp.close(resolve));
  const mine = await db()
    .select({ id: ssoProvider.providerId })
    .from(ssoProvider)
    .where(inArray(ssoProvider.userId, [userIds.registrant, ...registrants]));
  const ids = mine.map((row) => row.id);
  if (ids.length) {
    await db().delete(account).where(inArray(account.providerId, ids));
    await db().delete(ssoProviderState).where(inArray(ssoProviderState.providerId, ids));
    await db().delete(audit).where(inArray(audit.targetId, ids));
    await db().delete(ssoProvider).where(inArray(ssoProvider.providerId, ids));
  }
  await db()
    .delete(audit)
    .where(inArray(audit.actorId, [owner.id, ...Object.values(userIds)]));
  await db()
    .delete(session)
    .where(inArray(session.userId, Object.values(userIds)));
  await db()
    .delete(user)
    .where(inArray(user.id, Object.values(userIds)));
});
const oidc = (id: string, extra: Record<string, unknown> = {}) => ({
  providerId: id,
  issuer: idpUrl,
  domain: `${id}.example.test`,
  oidc: { clientId: `client-${id}-1234`, clientSecret: `secret-of-${id}`, ...extra },
});
describe("registering a provider", () => {
  it("is for the owner: an operator, a token and an inactive owner are refused", async () => {
    const id = provider("rights");
    for (const other of [operator, token, { ...owner, active: false }]) {
      expect(await outcome(registerSsoProvider(other, headers, oidc(id))), other.id).toBe(
        "forbidden",
      );
      expect(await outcome(listSsoProviders(other)), other.id).toBe("forbidden");
      expect(await outcome(testSsoProvider(other, id)), other.id).toBe("forbidden");
      expect(await outcome(disableSsoProvider(other, id)), other.id).toBe("forbidden");
      expect(await outcome(enableSsoProvider(other, id)), other.id).toBe("forbidden");
      expect(await outcome(verifySsoDomain(other, headers, id)), other.id).toBe("forbidden");
      expect(await outcome(requestSsoDomainRecord(other, headers, id)), other.id).toBe("forbidden");
      expect(
        await outcome(updateSsoProvider(other, headers, id, { domain: "x.example.test" })),
        other.id,
      ).toBe("forbidden");
      expect(await outcome(deleteSsoProvider(other, headers, id, { confirm: id })), other.id).toBe(
        "forbidden",
      );
    }
    expect(
      (await db().select().from(ssoProvider).where(eq(ssoProvider.providerId, id))).length,
    ).toBe(0);
  });
  it("answers with the record that proves the domain and never with the secret of the client", async () => {
    const id = provider("oidc");
    const made = await registerSsoProvider(owner, headers, oidc(id));
    expect(made).toMatchObject({
      providerId: id,
      type: "oidc",
      domain: `${id}.example.test`,
      domainVerified: false,
      disabled: false,
      clientIdLastFour: "1234",
      operators: [],
    });
    expect(made.callback).toBe(
      `${new URL(process.env.APP_URL ?? "http://localhost:3000").origin}/api/auth/sso/callback/${id}`,
    );
    expect(made.domainRecord?.name).toBe(`_better-auth-token-${id}.${id}.example.test`);
    expect(made.domainRecord?.value).toMatch(new RegExp(`^_better-auth-token-${id}=[\\w-]{10,}$`));
    const everywhere = JSON.stringify([
      made,
      await listSsoProviders(owner),
      await db().select().from(audit).where(eq(audit.targetId, id)),
    ]);
    expect(everywhere).not.toContain(`secret-of-${id}`);
    // At rest it is not in the column either.
    const [raw] = await db().execute<{ oidc_config: string }>(
      (await import("drizzle-orm"))
        .sql`select oidc_config from sso_provider where provider_id = ${id}`,
    );
    expect(raw?.oidc_config).not.toContain(`secret-of-${id}`);
    const [entry] = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.targetId, id), eq(audit.action, "sso_provider.register")));
    expect(entry).toMatchObject({
      actorId: owner.id,
      detail: { type: "oidc", domain: `${id}.example.test` },
    });
  });
  it("registers a SAML provider with its certificate and names the metadata of this side", async () => {
    const id = provider("saml");
    const made = await registerSsoProvider(owner, headers, {
      providerId: id,
      issuer: "https://idp.example.test/saml",
      domain: `${id}.example.test`,
      saml: { entryPoint: "https://idp.example.test/saml/sso", cert: certificates.long },
    });
    expect(made.type).toBe("saml");
    expect(made.metadata).toContain(`/api/auth/sso/saml2/sp/metadata?providerId=${id}`);
    expect(made.callback).toContain(`/api/auth/sso/saml2/sp/acs/${id}`);
    expect(made.clientIdLastFour).toBeNull();
  });
  it("refuses what is not asked for in the form: both protocols, none, a bad identifier, a bad domain, extra fields", async () => {
    const id = provider("bad");
    const base = oidc(id);
    expect(
      await outcome(
        registerSsoProvider(owner, headers, {
          ...base,
          saml: { entryPoint: "https://a.example.test", cert: certificates.long },
        }),
      ),
    ).toBe("invalid");
    expect(
      await outcome(
        registerSsoProvider(owner, headers, {
          providerId: id,
          issuer: idpUrl,
          domain: `${id}.example.test`,
        }),
      ),
    ).toBe("invalid");
    for (const wrong of ["UPPER", "has space", "-lead", "x".repeat(45), "dot.ted", ""])
      expect(
        await outcome(registerSsoProvider(owner, headers, { ...base, providerId: wrong })),
        wrong,
      ).toBe("invalid");
    expect(
      await outcome(registerSsoProvider(owner, headers, { ...base, domain: "localhost" })),
    ).toBe("invalid");
    expect(
      await outcome(registerSsoProvider(owner, headers, { ...base, issuer: "not a url" })),
    ).toBe("invalid");
    expect(await outcome(registerSsoProvider(owner, headers, { ...base, extra: 1 }))).toBe(
      "invalid",
    );
    expect(
      (await db().select().from(ssoProvider).where(eq(ssoProvider.providerId, id))).length,
    ).toBe(0);
  });
  it("refuses an identifier that is taken", async () => {
    const id = provider("twice");
    await registerSsoProvider(owner, headers, oidc(id));
    expect(await outcome(registerSsoProvider(owner, headers, oidc(id)))).not.toBe("ok");
    expect(
      (await db().select().from(ssoProvider).where(eq(ssoProvider.providerId, id))).length,
    ).toBe(1);
  });
});
describe("the domain of a provider", () => {
  beforeAll(async () => {
    await newRegistrant("domain");
  });
  it("is proved with the record, and only then does the provider count as verified", async () => {
    const id = provider("proof");
    const made = await registerSsoProvider(owner, headers, oidc(id));
    expect(await verifySsoDomain(owner, headers, id)).toMatchObject({
      domainVerified: false,
      result: "record_missing",
    });
    dns.txt.set(made.domainRecord?.name ?? "", [["_better-auth-token-other=zzzz"]]);
    expect((await verifySsoDomain(owner, headers, id)).result).toBe("record_missing");
    dns.txt.set(made.domainRecord?.name ?? "", [[made.domainRecord?.value ?? ""]]);
    const proved = await verifySsoDomain(owner, headers, id);
    expect(proved).toMatchObject({ domainVerified: true, result: "verified" });
    // Asked again, it is told that it is verified, and the record is not given out a second time.
    expect((await verifySsoDomain(owner, headers, id)).result).toBe("already_verified");
    expect(await requestSsoDomainRecord(owner, headers, id)).toMatchObject({
      domainVerified: true,
      record: null,
    });
    const entries = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.targetId, id), eq(audit.action, "sso_provider.verify_domain")));
    expect(entries).toHaveLength(1);
  });
  it("asks for the record first when the proof that was asked for is gone", async () => {
    const id = provider("gone");
    await registerSsoProvider(owner, headers, oidc(id));
    await db()
      .delete(verification)
      .where(like(verification.identifier, `%${id}%`));
    expect((await verifySsoDomain(owner, headers, id)).result).toBe("request_first");
  });
  it("gives the record again when it is asked for, as long as the domain is not verified", async () => {
    const id = provider("again");
    const made = await registerSsoProvider(owner, headers, oidc(id));
    const asked = await requestSsoDomainRecord(owner, headers, id);
    expect(asked.domainVerified).toBe(false);
    expect(asked.record?.value).toBe(made.domainRecord?.value);
    expect(await outcome(requestSsoDomainRecord(owner, headers, provider("nothere")))).toBe(
      "not_found",
    );
  });
  it("needs a new proof when it is changed, and the secret of the client can be replaced without showing it", async () => {
    const id = provider("change");
    const made = await registerSsoProvider(owner, headers, oidc(id));
    dns.txt.set(made.domainRecord?.name ?? "", [[made.domainRecord?.value ?? ""]]);
    await verifySsoDomain(owner, headers, id);
    const renamed = await updateSsoProvider(owner, headers, id, {
      clientSecret: `new-secret-${run}`,
    });
    expect(renamed.domainVerified).toBe(true);
    expect(JSON.stringify(renamed)).not.toContain(`new-secret-${run}`);
    const moved = await updateSsoProvider(owner, headers, id, {
      domain: `moved-${run}.example.test`,
    });
    expect(moved).toMatchObject({ domain: `moved-${run}.example.test`, domainVerified: false });
    const [entry] = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.targetId, id), eq(audit.action, "sso_provider.update")))
      .orderBy(audit.createdAt);
    expect(JSON.stringify(entry?.detail)).not.toContain("secret");
    // The scopes alone, and the scopes with the secret, are changes of the OIDC client too.
    expect(
      (await updateSsoProvider(owner, headers, id, { scopes: ["openid", "email"] })).domain,
    ).toBe(`moved-${run}.example.test`);
    expect(
      await outcome(
        updateSsoProvider(owner, headers, id, { scopes: ["openid"], clientSecret: `again-${run}` }),
      ),
    ).toBe("ok");
    expect(await outcome(updateSsoProvider(owner, headers, id, {}))).toBe("invalid");
    expect(
      await outcome(updateSsoProvider(owner, headers, id, { issuer: "https://x.example.test" })),
    ).toBe("invalid");
    expect(
      await outcome(
        updateSsoProvider(owner, headers, provider("nothere"), { domain: "a.example.test" }),
      ),
    ).toBe("not_found");
    const saml = provider("samlchange");
    await registerSsoProvider(owner, headers, {
      providerId: saml,
      issuer: "https://idp.example.test/saml",
      domain: `${saml}.example.test`,
      saml: { entryPoint: "https://idp.example.test/saml/sso", cert: certificates.long },
    });
    expect(await outcome(updateSsoProvider(owner, headers, saml, { clientSecret: "x" }))).toBe(
      "invalid_input",
    );
  });
});
describe("switching a provider off and on", () => {
  beforeAll(async () => {
    await newRegistrant("switch");
  });
  async function verified(label: string) {
    const id = provider(label);
    const made = await registerSsoProvider(owner, headers, oidc(id));
    dns.txt.set(made.domainRecord?.name ?? "", [[made.domainRecord?.value ?? ""]]);
    await verifySsoDomain(owner, headers, id);
    return id;
  }
  it("refuses sign-in through the plugin while it is off, leaves the operators linked and gives the domain back on", async () => {
    const id = await verified("switch");
    await db()
      .insert(account)
      .values({
        id: randomUUID(),
        accountId: `idp-${run}`,
        providerId: id,
        userId: userIds.linked,
      });
    const off = await disableSsoProvider(owner, id);
    expect(off).toMatchObject({ disabled: true, domainVerified: false });
    expect(off.operators.map((person) => person.id)).toEqual([userIds.linked]);
    // The plugin reads the column; this is what it refuses a provider by.
    const [row] = await db().select().from(ssoProvider).where(eq(ssoProvider.providerId, id));
    expect(row?.domainVerified).toBe(false);
    expect(
      (await db().select().from(ssoProviderState).where(eq(ssoProviderState.providerId, id)))[0]
        ?.verifiedBefore,
    ).toBe(true);
    // Switching off twice changes nothing and writes nothing more.
    await disableSsoProvider(owner, id);
    expect(
      await db()
        .select()
        .from(audit)
        .where(and(eq(audit.targetId, id), eq(audit.action, "sso_provider.disable"))),
    ).toHaveLength(1);
    // A proof does not switch it on; switching on does.
    expect(await outcome(verifySsoDomain(owner, headers, id))).toBe("conflict");
    const on = await enableSsoProvider(owner, id);
    expect(on).toMatchObject({ disabled: false, domainVerified: true });
    expect(
      await db().select().from(ssoProviderState).where(eq(ssoProviderState.providerId, id)),
    ).toHaveLength(0);
    await enableSsoProvider(owner, id);
    expect(
      await db()
        .select()
        .from(audit)
        .where(and(eq(audit.targetId, id), eq(audit.action, "sso_provider.enable"))),
    ).toHaveLength(1);
  });
  it("does not make a domain valid that was never proved", async () => {
    const id = provider("never");
    await registerSsoProvider(owner, headers, oidc(id));
    expect((await disableSsoProvider(owner, id)).disabled).toBe(true);
    expect(await enableSsoProvider(owner, id)).toMatchObject({
      disabled: false,
      domainVerified: false,
    });
    expect(await outcome(disableSsoProvider(owner, provider("nothere")))).toBe("not_found");
  });
});
describe("testing a provider", () => {
  beforeAll(async () => {
    await newRegistrant("a");
  });
  // The provider of the test is on a local address, which only the development stack may read.
  beforeAll(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_BOOTSTRAP", "true");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  async function verified(label: string, extra: Record<string, unknown> = {}) {
    const id = provider(label);
    const made = await registerSsoProvider(owner, headers, oidc(id, extra));
    dns.txt.set(made.domainRecord?.name ?? "", [[made.domainRecord?.value ?? ""]]);
    await verifySsoDomain(owner, headers, id);
    return id;
  }
  it("finds an OIDC provider in order: the documents are read, agree and name keys", async () => {
    const id = await verified("ok");
    const result = await testSsoProvider(owner, id);
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual([
      "domain",
      "discovery",
      "issuer",
      "endpoints",
      "keys",
    ]);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });
  it("says what is wrong: another issuer, no keys, a domain that is not verified, a provider that does not answer", async () => {
    const id = await verified("wrong");
    idpIssuer = "https://someone-else.example.test";
    const other = await testSsoProvider(owner, id);
    expect(other.ok).toBe(false);
    expect(other.checks.find((check) => check.name === "issuer")).toMatchObject({ ok: false });
    expect(other.checks.find((check) => check.name === "discovery")?.ok).toBe(true);
    idpIssuer = null;
    idpKeys = [];
    const noKeys = await testSsoProvider(owner, id);
    expect(noKeys.checks.find((check) => check.name === "keys")).toMatchObject({ ok: false });
    idpKeys = [{ kty: "RSA", kid: "k1", n: "AQAB", e: "AQAB" }];
    await disableSsoProvider(owner, id);
    expect((await testSsoProvider(owner, id)).checks[0]).toMatchObject({
      name: "domain",
      ok: false,
    });
    const silent = provider("silent");
    await registerSsoProvider(
      owner,
      headers,
      oidc(silent, { discoveryEndpoint: `${idpUrl}/.well-known/openid-configuration` }),
    );
    await db()
      .update(ssoProvider)
      .set({ issuer: "http://127.0.0.1:1" })
      .where(eq(ssoProvider.providerId, silent));
    const [row] = await db().select().from(ssoProvider).where(eq(ssoProvider.providerId, silent));
    expect(row?.issuer).toBe("http://127.0.0.1:1");
    expect(await outcome(testSsoProvider(owner, provider("nothere")))).toBe("not_found");
  });
  it("reads the certificate of a SAML provider: valid, and about to end", async () => {
    const long = provider("samllong");
    const short = provider("samlshort");
    for (const [id, cert] of [
      [long, certificates.long],
      [short, certificates.short],
    ] as const)
      await registerSsoProvider(owner, headers, {
        providerId: id,
        issuer: "https://idp.example.test/saml",
        domain: `${id}.example.test`,
        saml: { entryPoint: "https://idp.example.test/saml/sso", cert },
      });
    const fine = await testSsoProvider(owner, long);
    expect(fine.checks.find((check) => check.name === "certificate")).toMatchObject({ ok: true });
    const ending = await testSsoProvider(owner, short);
    expect(ending.ok).toBe(false);
    expect(ending.checks.find((check) => check.name === "certificate")).toMatchObject({
      ok: false,
    });
  });
  it("does not read a provider outside the development stack unless it is on a public address over https", async () => {
    const id = await verified("outside");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_BOOTSTRAP", "false");
    try {
      const plain = await testSsoProvider(owner, id);
      expect(plain.ok).toBe(false);
      expect(JSON.stringify(plain.checks.find((check) => check.name === "discovery"))).toContain(
        "not_https",
      );
      await db()
        .update(ssoProvider)
        .set({
          issuer: "https://127.0.0.1:9",
          oidcConfig: JSON.stringify({
            discoveryEndpoint: "https://127.0.0.1:9/.well-known/openid-configuration",
          }),
        })
        .where(eq(ssoProvider.providerId, id));
      const refused = await testSsoProvider(owner, id);
      expect(refused.ok).toBe(false);
      expect(refused.checks.find((check) => check.name === "discovery")).toMatchObject({
        ok: false,
      });
    } finally {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("DEV_BOOTSTRAP", "true");
    }
  });
  it("names each thing that is missing in the document of the provider", async () => {
    const id = await verified("missing");
    const failing = async () =>
      (await testSsoProvider(owner, id)).checks
        .filter((check) => !check.ok)
        .map((check) => check.name);
    idpOmit = ["issuer"];
    expect(await failing()).toContain("issuer");
    idpOmit = ["token_endpoint"];
    expect(await failing()).toContain("endpoints");
    idpOmit = ["jwks_uri"];
    expect(await failing()).toEqual(expect.arrayContaining(["endpoints", "keys"]));
    idpOmit = [];
    idpKeys = "not a list";
    expect(await failing()).toEqual(["keys"]);
  });
  it("reads a certificate that has ended, a missing one and an entry point that does not answer", async () => {
    const entry = provider("samlentry");
    await registerSsoProvider(owner, headers, {
      providerId: entry,
      issuer: "https://idp.example.test/saml",
      domain: `${entry}.example.test`,
      saml: { entryPoint: `${idpUrl}/broken`, cert: certificates.short },
    });
    const broken = await testSsoProvider(owner, entry);
    expect(broken.checks.find((check) => check.name === "entry point")).toMatchObject({
      ok: false,
    });
    await db()
      .update(ssoProvider)
      .set({ samlConfig: JSON.stringify({ entryPoint: `${idpUrl}/missing-page` }) })
      .where(eq(ssoProvider.providerId, entry));
    const bare = await testSsoProvider(owner, entry);
    expect(bare.checks.find((check) => check.name === "certificate")).toMatchObject({ ok: false });
    // An entry point that answers with a 404 still answers.
    expect(bare.checks.find((check) => check.name === "entry point")).toMatchObject({ ok: true });
    await db()
      .update(ssoProvider)
      .set({ samlConfig: JSON.stringify({ cert: certificates.short }) })
      .where(eq(ssoProvider.providerId, entry));
    expect(
      (await testSsoProvider(owner, entry)).checks.find((check) => check.name === "entry point"),
    ).toMatchObject({ ok: false });
    // Years later both certificates have ended.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2040-01-01T00:00:00Z") });
    try {
      const ended = await testSsoProvider(owner, provider("samllong"));
      expect(ended.checks.find((check) => check.name === "certificate")?.ok).toBe(false);
      expect(JSON.stringify(ended.checks)).toContain("ended");
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("the operators of a provider and the deletion", () => {
  beforeAll(async () => {
    await newRegistrant("operators");
  });
  it("lists the operators that are linked and loses them with the provider, after its identifier was typed", async () => {
    const id = provider("delete");
    await registerSsoProvider(owner, headers, oidc(id));
    await db()
      .insert(account)
      .values({
        id: randomUUID(),
        accountId: `idp-del-${run}`,
        providerId: id,
        userId: userIds.linked,
      });
    const [listed] = (await listSsoProviders(owner)).filter((row) => row.providerId === id);
    expect(listed?.operators).toEqual([
      {
        id: userIds.linked,
        name: "Linked Person",
        email: `${userIds.linked}@example.test`,
        active: true,
      },
    ]);
    for (const wrong of ["", "wrong", `${id} `, id.toUpperCase()])
      expect(
        await outcome(deleteSsoProvider(owner, headers, id, { confirm: wrong })),
        wrong,
      ).not.toBe("ok");
    expect(await outcome(deleteSsoProvider(owner, headers, id, { confirm: id, extra: 1 }))).toBe(
      "invalid",
    );
    expect(
      (await db().select().from(ssoProvider).where(eq(ssoProvider.providerId, id))).length,
    ).toBe(1);
    const done = await deleteSsoProvider(owner, headers, id, { confirm: id });
    expect(done).toEqual({ deleted: true, operators: 1 });
    expect(
      await db().select().from(ssoProvider).where(eq(ssoProvider.providerId, id)),
    ).toHaveLength(0);
    expect(await db().select().from(account).where(eq(account.providerId, id))).toHaveLength(0);
    const [entry] = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.targetId, id), eq(audit.action, "sso_provider.delete")));
    expect(entry?.detail).toMatchObject({ type: "oidc", operators: 1 });
    expect(await outcome(deleteSsoProvider(owner, headers, id, { confirm: id }))).toBe("not_found");
  });
  it("writes the sign-in of an operator through a provider into the audit, with the provider when it is named", async () => {
    await auditSsoSignIn(userIds.linked, "keycloak-oidc");
    await auditSsoSignIn(userIds.linked);
    const entries = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.actorId, userIds.linked), eq(audit.action, "operator.sso_sign_in")));
    expect(entries.map((entry) => entry.detail)).toEqual(
      expect.arrayContaining([{ providerId: "keycloak-oidc" }, {}]),
    );
  });
});
describe("the routes of the plugin", () => {
  it("still answer an owner's session for the list, so that registration through the API keeps working", async () => {
    const answered = await auth().api.listSSOProviders({ headers });
    expect(Array.isArray((answered as { providers: unknown[] }).providers)).toBe(true);
    // And a call without a session is refused by the plugin itself.
    await expect(auth().api.listSSOProviders({ headers: new Headers() })).rejects.toBeDefined();
  });
});
