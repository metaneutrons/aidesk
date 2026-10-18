import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { NextRequest } from "next/server";
import { ZodError } from "zod";
// What the DNS answers for a name: a list of text records, each as the chunks that a record is made of. A name
// that is not in the table has no record; a name set to "fail" cannot be asked.
const dns = vi.hoisted(() => ({ txt: new Map<string, string[][] | "fail">() }));
vi.mock("node:dns/promises", () => ({
  lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
  resolveTxt: (name: string) => {
    const found = dns.txt.get(name);
    if (found === "fail")
      return Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    if (!found) return Promise.reject(Object.assign(new Error("nx"), { code: "ENODATA" }));
    return Promise.resolve(found);
  },
}));
import { db } from "../src/server/db";
import {
  audit,
  messages,
  participants,
  portalDomains,
  projects,
  tickets,
} from "../src/server/db/schema";
import {
  addPortalDomain,
  applicationHost,
  forgetPortalHosts,
  isApplicationHost,
  listPortalDomains,
  portalBase,
  portalHost,
  hasOwnPortalName,
  addInstallationPortalDomain,
  listInstallationPortalDomains,
  removeInstallationPortalDomain,
  verifyInstallationPortalDomain,
  portalOriginAllowed,
  removePortalDomain,
  verifyPortalDomain,
} from "../src/server/portal-domains";
import {
  getPortalTicket,
  issuePortalGrant,
  portalReply,
  portalUrl,
  resolvePortalGrant,
  revokePortalGrant,
} from "../src/server/portal";
import { POST as portalRoute } from "../src/app/api/portal/reply/route";
import { proxy } from "../src/proxy";
import {
  challengeName,
  challengeValue,
  hostName,
  hostOf,
  portalHostMayServe,
} from "../src/domain/portal-domains";
import { DomainError } from "../src/server/errors";
import { env } from "../src/server/env";
import type { Action, Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectA = randomUUID();
const projectB = randomUUID();
const name = (label: string) => `${label}-${run}.example.test`;
const person = (
  id: string,
  kind: "human" | "agent",
  project: string,
  held: Action[],
): Principal => ({
  id: `${id}-${run}`,
  kind,
  active: true,
  owner: false,
  grants: [{ projectId: project, actions: held }],
});
const owner: Principal = { ...person("owner", "human", projectA, ["project.read"]), owner: true };
const managerA = person("manager-a", "human", projectA, ["project.read", "project.manage"]);
const managerB = person("manager-b", "human", projectB, ["project.read", "project.manage"]);
const agentA = person("agent-a", "agent", projectA, ["project.read", "project.manage"]);
const plainA = person("plain-a", "human", projectA, ["project.read", "ticket.read"]);
const staffA = person("staff-a", "human", projectA, [
  "project.read",
  "ticket.read",
  "ticket.reply",
]);
const staffB = person("staff-b", "human", projectB, [
  "project.read",
  "ticket.read",
  "ticket.reply",
]);
// The project that a name belongs to, or null for a name that is none or the installation's.
const projectOfHost = async (host: string | null) => {
  const found = await portalHost(host);
  return found?.kind === "project" ? found.projectId : null;
};
const asProject = (projectId: string) => ({ kind: "project", projectId }) as const;
const outcome = async (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) =>
      error instanceof DomainError ? error.code : error instanceof ZodError ? "invalid" : "other",
  );
// A claim that is proved: the record exists in the DNS with the token of the claim.
async function claim(principal: Principal, project: string, host: string, prove = true) {
  const added = await addPortalDomain(principal, project, { host });
  if (prove) dns.txt.set(added.challenge.name, [[added.challenge.value]]);
  return added;
}
async function ticketOf(project: string) {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject: "Portal domains",
      requesterEmail: `customer-${run}@example.test`,
      requesterName: "Customer",
      language: "en",
    })
    .returning();
  if (!row) throw new Error("ticket");
  await db()
    .insert(messages)
    .values({
      ticketId: row.id,
      language: "en",
      authorType: "customer",
      authorName: "Customer",
      authorEmail: `customer-${run}@example.test`,
      markdown: "Hello",
      deliveryState: "received",
    });
  return row.id;
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectA, name: "Domains A", slug: `domains-a-${run}` },
      { id: projectB, name: "Domains B", slug: `domains-b-${run}` },
    ]);
});
beforeEach(async () => {
  dns.txt.clear();
  // Every test starts without a name of either project, so that none depends on what another left.
  await db()
    .delete(portalDomains)
    .where(inArray(portalDomains.projectId, [projectA, projectB]));
  await db()
    .delete(portalDomains)
    .where(and(isNull(portalDomains.projectId), eq(portalDomains.createdBy, owner.id)));
  forgetPortalHosts();
});
afterAll(async () => {
  const ids = [projectA, projectB];
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
});
describe("the shape of a name", () => {
  it("takes the names of a customer and lower-cases them", () => {
    expect(hostName.parse("Help.Example.ORG")).toBe("help.example.org");
    expect(hostName.parse("  hello.example.org ")).toBe("hello.example.org");
    expect(hostName.parse("a-b.c-d.example.rocks")).toBe("a-b.c-d.example.rocks");
    expect(hostName.parse("xn--mnchen-3ya.example.org")).toBe("xn--mnchen-3ya.example.org");
  });
  it("refuses what is not a public name", () => {
    for (const bad of [
      "localhost",
      "example",
      "192.168.0.1",
      "[::1]",
      "host.example.org:3000",
      "a_b.example.org",
      "-a.example.org",
      "a-.example.org",
      ".example.org",
      "example..org",
      "example.org/path",
      "https://example.org",
      "exa mple.org",
      "münchen.example.org",
      "printer.local",
      "db.internal",
      `${"a".repeat(64)}.example.org`,
      `${"a.".repeat(130)}org`,
      "example.123",
      "",
    ])
      expect(hostName.safeParse(bad).success, bad).toBe(false);
  });
  it("answers the host of a request without its port, and the first of a list", () => {
    expect(hostOf("Help.Example.org:8443")).toBe("help.example.org");
    expect(hostOf("a.example.org, b.example.org")).toBe("a.example.org");
    expect(hostOf(null)).toBeNull();
    expect(hostOf("")).toBeNull();
  });
  it("lets a name serve the customer page and nothing else", () => {
    for (const ok of ["/portal/abc", "/api/portal/reply", "/_next/static/x.js", "/favicon.ico"])
      expect(portalHostMayServe(ok), ok).toBe(true);
    for (const no of [
      "/",
      "/login",
      "/setup",
      "/recover",
      "/api/v1/projects",
      "/api/auth/sign-in/email",
      "/api/mcp",
      "/api/worker/tick",
      "/portalx",
      "/portal-evil/x",
      "/api/portalx",
    ])
      expect(portalHostMayServe(no), no).toBe(false);
  });
});
describe("claiming, proving and removing a name", () => {
  it("is for people who manage the project: an agent, a person without the right and another project are refused", async () => {
    const host = name("rights");
    expect(await outcome(addPortalDomain(agentA, projectA, { host }))).toBe("forbidden");
    expect(await outcome(addPortalDomain(plainA, projectA, { host }))).toBe("not_found");
    expect(await outcome(addPortalDomain(managerB, projectA, { host }))).toBe("not_found");
    expect(await outcome(listPortalDomains(plainA, projectA))).toBe("not_found");
    const added = await addPortalDomain(managerA, projectA, { host });
    expect(await outcome(verifyPortalDomain(managerB, projectA, added.id))).toBe("not_found");
    expect(await outcome(verifyPortalDomain(managerB, projectB, added.id))).toBe("not_found");
    expect(await outcome(removePortalDomain(managerB, projectA, added.id))).toBe("not_found");
    expect(await outcome(removePortalDomain(managerB, projectB, added.id))).toBe("not_found");
    expect(await outcome(removePortalDomain(agentA, projectA, added.id))).toBe("forbidden");
    expect((await listPortalDomains(managerA, projectA)).some((row) => row.host === host)).toBe(
      true,
    );
    expect((await listPortalDomains(managerB, projectB)).some((row) => row.host === host)).toBe(
      false,
    );
  });
  it("names the record to create, and claiming a name again gives the same claim", async () => {
    const host = name("again");
    const first = await addPortalDomain(managerA, projectA, { host });
    expect(first).toMatchObject({ host, verified: false, verifiedAt: null });
    expect(first.challenge.name).toBe(`_aidesk-challenge.${host}`);
    expect(first.challenge.value).toMatch(/^aidesk-verify=[0-9a-f]{32}$/);
    const second = await addPortalDomain(managerA, projectA, { host: host.toUpperCase() });
    expect(second.id).toBe(first.id);
    expect(second.challenge).toEqual(first.challenge);
    expect(challengeName(host)).toBe(first.challenge.name);
    expect(challengeValue("x")).toBe("aidesk-verify=x");
    const entries = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.projectId, projectA), eq(audit.action, "portal_domain.add")));
    expect(entries.filter((entry) => entry.targetId === first.id)).toHaveLength(1);
  });
  it("refuses a name that is invalid or is the address of the application", async () => {
    expect(await outcome(addPortalDomain(managerA, projectA, { host: "localhost" }))).toBe(
      "invalid",
    );
    expect(await outcome(addPortalDomain(managerA, projectA, { host: "" }))).toBe("invalid");
    expect(await outcome(addPortalDomain(managerA, projectA, { host: name("x"), more: 1 }))).toBe(
      "invalid",
    );
    expect(await outcome(addPortalDomain(managerA, projectA, null))).toBe("invalid");
    // The address of the application is never a name of a customer page. In this run it carries a port and is
    // refused as a name; with a public address of its own it is refused as taken (the comparison is what
    // decides, so it is tested by itself).
    expect(await outcome(addPortalDomain(managerA, projectA, { host: applicationHost() }))).toBe(
      "invalid",
    );
    expect(isApplicationHost("app.example.org", "https://app.example.org")).toBe(true);
    expect(isApplicationHost("APP.example.org", "https://App.Example.org/path")).toBe(true);
    expect(isApplicationHost("other.example.org", "https://app.example.org")).toBe(false);
    expect(isApplicationHost("app.example.org", "https://app.example.org:8443")).toBe(false);
  });
  it("stays unverified until the record with the token of the claim is in the DNS", async () => {
    const host = name("proof");
    const added = await addPortalDomain(managerA, projectA, { host });
    // No record at all, a record with another token, a record with the right token under another name.
    expect(await verifyPortalDomain(managerA, projectA, added.id)).toMatchObject({
      verified: false,
      result: "record_missing",
    });
    dns.txt.set(added.challenge.name, [["aidesk-verify=00000000000000000000000000000000"]]);
    expect((await verifyPortalDomain(managerA, projectA, added.id)).result).toBe("record_missing");
    dns.txt.clear();
    dns.txt.set(`_aidesk-challenge.other-${host}`, [[added.challenge.value]]);
    expect((await verifyPortalDomain(managerA, projectA, added.id)).result).toBe("record_missing");
    // A DNS that cannot be asked is not a proof either, and says so.
    dns.txt.set(added.challenge.name, "fail");
    expect(await verifyPortalDomain(managerA, projectA, added.id)).toMatchObject({
      verified: false,
      result: "dns_error",
    });
    expect(await projectOfHost(host)).toBeNull();
    // The record, split into the chunks that a long text record is made of, among others.
    dns.txt.set(added.challenge.name, [
      ["v=spf1 -all"],
      [added.challenge.value.slice(0, 10), added.challenge.value.slice(10)],
    ]);
    const proved = await verifyPortalDomain(managerA, projectA, added.id);
    expect(proved).toMatchObject({ verified: true, result: "verified" });
    expect(proved.verifiedAt).toBeInstanceOf(Date);
    expect(await projectOfHost(host)).toBe(projectA);
    // Asked again after the proof, it stays proved, also when the record is gone.
    dns.txt.clear();
    expect((await verifyPortalDomain(managerA, projectA, added.id)).result).toBe("verified");
    const entries = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.projectId, projectA), eq(audit.action, "portal_domain.verify")));
    expect(entries.filter((entry) => entry.targetId === added.id)).toHaveLength(1);
  });
  it("belongs to the project that proved it first, and the other project cannot take it", async () => {
    const host = name("first");
    const a = await addPortalDomain(managerA, projectA, { host });
    // The other project may claim the name while it is unproved, and may not prove it with the record of the first.
    const b = await addPortalDomain(managerB, projectB, { host });
    expect(b.challenge.value).not.toBe(a.challenge.value);
    dns.txt.set(a.challenge.name, [[a.challenge.value]]);
    expect((await verifyPortalDomain(managerB, projectB, b.id)).result).toBe("record_missing");
    expect((await verifyPortalDomain(managerA, projectA, a.id)).verified).toBe(true);
    // The record of both is there, which only the owner of the name can make: the second to prove loses.
    dns.txt.set(a.challenge.name, [[a.challenge.value], [b.challenge.value]]);
    expect(await outcome(verifyPortalDomain(managerB, projectB, b.id))).toBe("conflict");
    expect(await projectOfHost(host)).toBe(projectA);
    // Once a project has proved the name, no other project can claim it, not even again.
    expect(await outcome(addPortalDomain(managerB, projectB, { host }))).toBe("conflict");
  });
  it("is removed with its record of who did it, and links keep working on the shared address", async () => {
    const host = name("gone");
    const added = await claim(managerA, projectA, host);
    await verifyPortalDomain(managerA, projectA, added.id);
    expect(await projectOfHost(host)).toBe(projectA);
    expect(await removePortalDomain(managerA, projectA, added.id)).toEqual({
      removed: true,
      host,
    });
    expect(await projectOfHost(host)).toBeNull();
    expect(await outcome(removePortalDomain(managerA, projectA, added.id))).toBe("not_found");
    const [entry] = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.projectId, projectA), eq(audit.action, "portal_domain.remove")));
    expect(entry?.detail).toMatchObject({ host, wasVerified: true });
  });
});
describe("the lookup of a name", () => {
  it("knows only verified names, in any case and with a port, and takes the first of a list", async () => {
    const host = name("lookup");
    const added = await claim(managerA, projectA, host, false);
    expect(await projectOfHost(host)).toBeNull();
    dns.txt.set(added.challenge.name, [[added.challenge.value]]);
    await verifyPortalDomain(managerA, projectA, added.id);
    expect(await projectOfHost(host)).toBe(projectA);
    expect(await projectOfHost(host.toUpperCase())).toBe(projectA);
    expect(await projectOfHost(`${host}:8443`)).toBe(projectA);
    expect(await projectOfHost(`${host}, other.example.org`)).toBe(projectA);
    expect(await projectOfHost(null)).toBeNull();
    expect(await projectOfHost("never-claimed.example.test")).toBeNull();
    expect(await projectOfHost(`sub.${host}`)).toBeNull();
  });
  it("drops a removed name at once in this process", async () => {
    const host = name("drop");
    const added = await claim(managerA, projectA, host);
    await verifyPortalDomain(managerA, projectA, added.id);
    expect(await projectOfHost(host)).toBe(projectA);
    await removePortalDomain(managerA, projectA, added.id);
    expect(await projectOfHost(host)).toBeNull();
  });
});
describe("the address of a link", () => {
  it("is the shared address until the project has a verified name, then the oldest one", async () => {
    const shared = new URL(env().APP_URL).origin;
    expect(await portalBase(projectB)).toBe(shared);
    expect(await portalUrl("tok", projectB)).toBe(`${shared}/portal/tok`);
    const pending = await claim(managerB, projectB, name("pending"), false);
    expect(pending.verified).toBe(false);
    expect(await portalBase(projectB)).toBe(shared);
    const first = await claim(managerB, projectB, name("one"));
    await verifyPortalDomain(managerB, projectB, first.id);
    const second = await claim(managerB, projectB, name("two"));
    await verifyPortalDomain(managerB, projectB, second.id);
    expect(await portalBase(projectB)).toBe(`https://${first.host}`);
    expect(await portalUrl("tok", projectB)).toBe(`https://${first.host}/portal/tok`);
    // Another project is not affected.
    expect(await portalBase(projectA)).not.toContain(first.host);
    await removePortalDomain(managerB, projectB, first.id);
    expect(await portalBase(projectB)).toBe(`https://${second.host}`);
  });
  it("is the one that the link for the operator and the link in mail are given", async () => {
    const host = name("links");
    const added = await claim(managerA, projectA, host);
    await verifyPortalDomain(managerA, projectA, added.id);
    const ticket = await ticketOf(projectA);
    const grant = await issuePortalGrant(staffA, ticket);
    expect(grant.projectId).toBe(projectA);
    expect(await portalUrl(grant.token, grant.projectId)).toBe(
      `https://${host}/portal/${grant.token}`,
    );
    await removePortalDomain(managerA, projectA, added.id);
  });
});
describe("a link on the name of a project", () => {
  async function setup() {
    const hostA = name("on-a");
    const hostB = name("on-b");
    for (const [principal, project, host] of [
      [managerA, projectA, hostA],
      [managerB, projectB, hostB],
    ] as const) {
      const added = await claim(principal, project, host);
      await verifyPortalDomain(principal, project, added.id);
    }
    const ticketA = await ticketOf(projectA);
    const ticketB = await ticketOf(projectB);
    return {
      hostA,
      hostB,
      a: await issuePortalGrant(staffA, ticketA),
      b: await issuePortalGrant(staffB, ticketB),
      ticketA,
    };
  }
  it("opens on the shared address and on the name of its own project, and on no other name", async () => {
    const { hostA, hostB, a, b, ticketA } = await setup();
    // The shared address: no name in the request, every link opens.
    expect((await resolvePortalGrant(a.token, null))?.projectId).toBe(projectA);
    expect((await resolvePortalGrant(b.token, null))?.projectId).toBe(projectB);
    // The name of the project of the link.
    expect((await resolvePortalGrant(a.token, await portalHost(hostA)))?.ticketId).toBe(ticketA);
    // The name of another project: the link does not open there, and says nothing about why.
    expect(await resolvePortalGrant(a.token, await portalHost(hostB))).toBeNull();
    expect(await resolvePortalGrant(b.token, await portalHost(hostA))).toBeNull();
    await expect(getPortalTicket(a.token, "en", asProject(projectB))).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    const same = await getPortalTicket(a.token, "en", asProject(projectA));
    expect(same.messages.length).toBeGreaterThan(0);
    expect(same.messages.every((message) => !JSON.stringify(message).includes("Internal"))).toBe(
      true,
    );
  });
  it("is refused on the name of another project when a reply is sent, and nothing is kept", async () => {
    const { a, ticketA } = await setup();
    const before = await db().select().from(messages).where(eq(messages.ticketId, ticketA));
    await expect(
      portalReply(
        a.token,
        { markdown: "Wrong name", idempotencyKey: randomUUID() },
        [],
        asProject(projectB),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await db().select().from(messages).where(eq(messages.ticketId, ticketA))).toHaveLength(
      before.length,
    );
    const sent = await portalReply(
      a.token,
      { markdown: "Right name", idempotencyKey: randomUUID() },
      [],
      asProject(projectA),
    );
    expect(sent.duplicate).toBe(false);
  });
  it("fails on both the shared address and the name once it is revoked", async () => {
    const { a } = await setup();
    const ticketA = (await resolvePortalGrant(a.token, null))?.ticketId ?? "";
    await revokePortalGrant(staffA, ticketA);
    expect(await resolvePortalGrant(a.token, null)).toBeNull();
    expect(await resolvePortalGrant(a.token, asProject(projectA))).toBeNull();
    const rows = await db().select().from(participants).where(eq(participants.ticketId, ticketA));
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });
});
describe("a request on a name", () => {
  const request = (host: string, path: string, headers: Record<string, string> = {}) =>
    new NextRequest(`https://${host}${path}`, { headers: { host, ...headers } });
  const passed = (response: Response) => response.headers.get("x-middleware-next") === "1";
  it("serves the customer page and its reply on the name of a project, and nothing of the desk", async () => {
    const host = name("serves");
    const added = await claim(managerA, projectA, host);
    await verifyPortalDomain(managerA, projectA, added.id);
    expect(passed(await proxy(request(host, "/portal/abc")))).toBe(true);
    expect(passed(await proxy(request(host, "/api/portal/reply")))).toBe(true);
    expect(passed(await proxy(request(host, "/_next/static/chunks/a.js")))).toBe(true);
    for (const path of [
      "/",
      "/login",
      "/setup",
      "/api/v1/projects",
      "/api/auth/get-session",
      "/api/mcp",
    ]) {
      const answer = await proxy(request(host, path));
      expect(answer.status, path).toBe(404);
      expect(passed(answer), path).toBe(false);
      expect(answer.headers.get("cache-control")).toBe("no-store");
    }
    // Behind a proxy that hands the host on, the name in the header counts.
    expect(
      (await proxy(request("internal.example.test", "/login", { "x-forwarded-host": host })))
        .status,
    ).toBe(404);
  });
  it("leaves the address of the application and every name that is no customer page as it was", async () => {
    expect(passed(await proxy(request(applicationHost(), "/login")))).toBe(true);
    expect(passed(await proxy(request(applicationHost(), "/api/v1/projects")))).toBe(true);
    expect(passed(await proxy(request("unclaimed.example.test", "/login")))).toBe(true);
    const host = name("pendingproxy");
    await claim(managerA, projectA, host, false);
    expect(passed(await proxy(request(host, "/login")))).toBe(true);
  });
  it("answers a name that was removed like any other name", async () => {
    const host = name("removedproxy");
    const added = await claim(managerA, projectA, host);
    await verifyPortalDomain(managerA, projectA, added.id);
    expect((await proxy(request(host, "/login"))).status).toBe(404);
    await removePortalDomain(managerA, projectA, added.id);
    expect(passed(await proxy(request(host, "/login")))).toBe(true);
  });
});
describe("the reply route on a name", () => {
  const origin = new URL(env().APP_URL).origin;
  const post = (token: string, headers: Record<string, string>) =>
    portalRoute(
      new Request(`${origin}/api/portal/reply`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ token, markdown: "From a name", idempotencyKey: randomUUID() }),
      }),
    );
  it("accepts the origin of a verified name and refuses an unverified one, an unknown one and plain http", async () => {
    const host = name("route");
    const added = await claim(managerA, projectA, host, false);
    const ticket = await ticketOf(projectA);
    const { token } = await issuePortalGrant(staffA, ticket);
    expect(await portalOriginAllowed(`https://${host}`)).toBe(false);
    expect((await post(token, { origin: `https://${host}`, host })).status).toBe(403);
    dns.txt.set(added.challenge.name, [[added.challenge.value]]);
    await verifyPortalDomain(managerA, projectA, added.id);
    expect(await portalOriginAllowed(`https://${host}`)).toBe(true);
    expect(await portalOriginAllowed(`http://${host}`)).toBe(false);
    expect(await portalOriginAllowed("https://never-claimed.example.test")).toBe(false);
    expect(await portalOriginAllowed("not a url")).toBe(false);
    expect(await portalOriginAllowed(null)).toBe(false);
    expect(await portalOriginAllowed(origin)).toBe(true);
    expect((await post(token, { origin: `https://${host}`, host })).status).toBe(201);
    expect((await post(token, { origin: "https://never-claimed.example.test", host })).status).toBe(
      403,
    );
    expect((await post(token, { host })).status).toBe(403);
  });
  it("does not take the link of another project on the name of a project", async () => {
    const hostB = name("routeb");
    const added = await claim(managerB, projectB, hostB);
    await verifyPortalDomain(managerB, projectB, added.id);
    const ticket = await ticketOf(projectA);
    const { token } = await issuePortalGrant(staffA, ticket);
    const refused = await post(token, { origin: `https://${hostB}`, host: hostB });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "not_found" });
    expect((await post(token, { origin })).status).toBe(201);
  });
});
describe("the name of the installation", () => {
  const request = (host: string, path: string) =>
    new NextRequest(`https://${host}${path}`, { headers: { host } });
  const passed = (response: Response) => response.headers.get("x-middleware-next") === "1";
  async function installationName(label: string) {
    const added = await addInstallationPortalDomain(owner, { host: name(label) });
    dns.txt.set(added.challenge.name, [[added.challenge.value]]);
    await verifyInstallationPortalDomain(owner, added.id);
    return added;
  }
  it("is set by the owner only: a person who manages a project, an agent and an inactive owner are refused", async () => {
    const host = name("inst-rights");
    for (const other of [managerA, plainA, agentA, { ...owner, active: false }]) {
      expect(await outcome(addInstallationPortalDomain(other, { host })), other.id).toBe(
        "forbidden",
      );
      expect(await outcome(listInstallationPortalDomains(other)), other.id).toBe("forbidden");
    }
    const added = await addInstallationPortalDomain(owner, { host });
    expect(await outcome(verifyInstallationPortalDomain(managerA, added.id))).toBe("forbidden");
    expect(await outcome(removeInstallationPortalDomain(managerA, added.id))).toBe("forbidden");
    expect((await listInstallationPortalDomains(owner)).map((row) => row.host)).toContain(host);
    // The claims of a project are not the claims of the installation, and the other way round.
    expect((await listPortalDomains(managerA, projectA)).map((row) => row.host)).not.toContain(
      host,
    );
    expect(await outcome(verifyPortalDomain(managerA, projectA, added.id))).toBe("not_found");
    expect(await outcome(removeInstallationPortalDomain(owner, randomUUID()))).toBe("not_found");
  });
  it("is claimed, proved and removed like the name of a project, with entries that belong to no project", async () => {
    const added = await installationName("inst-cycle");
    expect(await portalHost(added.host)).toEqual({ kind: "installation" });
    expect(await projectOfHost(added.host)).toBeNull();
    const entries = await db()
      .select()
      .from(audit)
      .where(and(isNull(audit.projectId), eq(audit.targetId, added.id)));
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      "portal_domain.add",
      "portal_domain.verify",
    ]);
    expect(entries[0]?.detail).toMatchObject({ host: added.host, scope: "installation" });
    await removeInstallationPortalDomain(owner, added.id);
    expect(await portalHost(added.host)).toBeNull();
    await db()
      .delete(audit)
      .where(and(isNull(audit.projectId), eq(audit.targetId, added.id)));
  });
  it("has one owner for a name: a project that proved it, or the installation, and not both", async () => {
    const taken = await claim(managerA, projectA, name("inst-taken"));
    await verifyPortalDomain(managerA, projectA, taken.id);
    expect(await outcome(addInstallationPortalDomain(owner, { host: taken.host }))).toBe(
      "conflict",
    );
    const wide = await installationName("inst-wide");
    expect(await outcome(addPortalDomain(managerA, projectA, { host: wide.host }))).toBe(
      "conflict",
    );
    // Both may be waiting for their proof; the second to prove loses.
    const host = name("inst-race");
    const first = await addInstallationPortalDomain(owner, { host });
    const second = await addPortalDomain(managerA, projectA, { host });
    dns.txt.set(first.challenge.name, [[first.challenge.value], [second.challenge.value]]);
    expect((await verifyInstallationPortalDomain(owner, first.id)).verified).toBe(true);
    expect(await outcome(verifyPortalDomain(managerA, projectA, second.id))).toBe("conflict");
    expect(await portalHost(host)).toEqual({ kind: "installation" });
  });
  it("gives a project without a name of its own its link, and a project with one keeps its own", async () => {
    const shared = new URL(env().APP_URL).origin;
    expect(await portalBase(projectA)).toBe(shared);
    const wide = await installationName("inst-base");
    expect(await portalBase(projectA)).toBe(`https://${wide.host}`);
    expect(await portalBase(projectB)).toBe(`https://${wide.host}`);
    const own = await claim(managerB, projectB, name("inst-own"));
    await verifyPortalDomain(managerB, projectB, own.id);
    expect(await hasOwnPortalName(projectB)).toBe(true);
    expect(await hasOwnPortalName(projectA)).toBe(false);
    expect(await portalBase(projectB)).toBe(`https://${own.host}`);
    expect(await portalBase(projectA)).toBe(`https://${wide.host}`);
    expect(await portalUrl("tok", projectA)).toBe(`https://${wide.host}/portal/tok`);
  });
  it("opens the links of the projects that have no name of their own, and not those that have one", async () => {
    const wide = await installationName("inst-open");
    const own = await claim(managerB, projectB, name("inst-own-b"));
    await verifyPortalDomain(managerB, projectB, own.id);
    const a = await issuePortalGrant(staffA, await ticketOf(projectA));
    const b = await issuePortalGrant(staffB, await ticketOf(projectB));
    const onWide = await portalHost(wide.host);
    const onOwn = await portalHost(own.host);
    // Project A has no name: its link opens on the name of the installation and on the shared address.
    expect((await resolvePortalGrant(a.token, onWide))?.projectId).toBe(projectA);
    expect((await resolvePortalGrant(a.token, null))?.projectId).toBe(projectA);
    expect(await resolvePortalGrant(a.token, onOwn)).toBeNull();
    // Project B has a name: its link opens there and on the shared address, not on the name of the installation.
    expect((await resolvePortalGrant(b.token, onOwn))?.projectId).toBe(projectB);
    expect((await resolvePortalGrant(b.token, null))?.projectId).toBe(projectB);
    expect(await resolvePortalGrant(b.token, onWide)).toBeNull();
    await expect(getPortalTicket(b.token, "en", onWide)).rejects.toMatchObject({ status: 404 });
    // When the project loses its name, its links open on the name of the installation.
    await removePortalDomain(managerB, projectB, own.id);
    expect((await resolvePortalGrant(b.token, await portalHost(wide.host)))?.projectId).toBe(
      projectB,
    );
  });
  it("serves the customer page and nothing else, and its origin may send a reply", async () => {
    const wide = await installationName("inst-serves");
    expect(passed(await proxy(request(wide.host, "/portal/abc")))).toBe(true);
    expect(passed(await proxy(request(wide.host, "/api/portal/reply")))).toBe(true);
    for (const path of ["/", "/login", "/api/v1/projects", "/api/auth/get-session", "/setup"])
      expect((await proxy(request(wide.host, path))).status, path).toBe(404);
    expect(await portalOriginAllowed(`https://${wide.host}`)).toBe(true);
    expect(await portalOriginAllowed(`http://${wide.host}`)).toBe(false);
  });
});
afterAll(async () => {
  await db()
    .delete(portalDomains)
    .where(inArray(portalDomains.projectId, [projectA, projectB]));
  await db()
    .delete(portalDomains)
    .where(and(isNull(portalDomains.projectId), eq(portalDomains.createdBy, owner.id)));
});
