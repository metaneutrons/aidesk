import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { portalHostMayServe } from "../src/domain/portal-domains";
// The routing of compose.coolify.yaml is the file config/traefik/aidesk.example.yml. It routes the customer pages
// by path and the application checks the same list again. A path that the application serves on a customer name but
// that the file does not pass would be a page that never loads, and a path that the file passes but the application
// refuses is only a second line of defence that no longer is one. The desk must stay behind its address ranges.
const compose = readFileSync(new URL("../compose.coolify.yaml", import.meta.url), "utf8");
const routing = readFileSync(
  new URL("../config/traefik/aidesk.example.yml", import.meta.url),
  "utf8",
);
const rule = (router: string): string => {
  const found = new RegExp(`^ {4}${router}:\\n(?: {6}.*\\n)*? {6}rule: "(.*)"$`, "m").exec(routing);
  if (found?.[1] === undefined) throw new Error(`no rule for ${router}`);
  return found[1];
};
const middlewaresOf = (router: string): string[] => {
  const found = new RegExp(
    `^ {4}${router}:\\n(?: {6}.*\\n)*? {6}middlewares: \\[(.*)\\]$`,
    "m",
  ).exec(routing);
  return (found?.[1] ?? "").split(",").map((name) => name.trim());
};
const portalRule = rule("aidesk-portal");
const matchers = [...portalRule.matchAll(/(PathPrefix|Path)\(`([^`]+)`\)/g)].map((found) => ({
  kind: found[1] ?? "",
  value: found[2] ?? "",
}));
// What Traefik does with a path under the matchers of the portal router.
const passes = (path: string): boolean =>
  matchers.some((m) => (m.kind === "Path" ? path === m.value : path.startsWith(m.value)));
const served = [
  "/portal",
  "/portal/abc",
  "/api/portal/reply",
  "/api/portal/logo/token",
  "/_next/static/chunks/a.js",
  "/favicon.ico",
  "/icon.svg",
  "/robots.txt",
];
const refused = [
  "/",
  "/login",
  "/setup",
  "/api/v1/tickets",
  "/api/auth/sign-in",
  "/api/mcp",
  "/api/health/ready",
  "/portalx",
  "/api/portalx",
  "/icon.png",
];
describe("the routes of the customer pages in the Traefik file", () => {
  it("find at least one matcher", () => {
    expect(matchers.length).toBeGreaterThan(0);
  });
  it("pass what the application serves on a customer name", () => {
    for (const path of served) {
      expect(portalHostMayServe(path), `application: ${path}`).toBe(true);
      expect(passes(path), `file: ${path}`).toBe(true);
    }
  });
  it("refuse what the application refuses on a customer name", () => {
    for (const path of refused) {
      expect(portalHostMayServe(path), `application: ${path}`).toBe(false);
      expect(passes(path), `file: ${path}`).toBe(false);
    }
  });
});
describe("the route of the desk in the Traefik file", () => {
  it("is one name and goes through the address ranges, and the customer pages do not", () => {
    expect(rule("aidesk-desk")).toMatch(/^Host\(`[^`]+`\)$/);
    expect(middlewaresOf("aidesk-desk")).toContain("aidesk-desk-only");
    expect(middlewaresOf("aidesk-portal")).not.toContain("aidesk-desk-only");
  });
  it("allows private and local ranges and no public one", () => {
    const ranges = /aidesk-desk-only:\n {6}ipAllowList:\n {8}sourceRange:\s*\[([^\]]*)\]/
      .exec(routing)?.[1]
      ?.split(",")
      .map((entry) => entry.trim().replaceAll('"', ""));
    expect(ranges).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "fc00::/7",
      "127.0.0.1/32",
      "::1/128",
    ]);
  });
  it("uses names that belong to the examples and not to an installation", () => {
    const names = [...routing.matchAll(/Host\(`([^`]+)`\)/g)].map((found) => found[1] ?? "");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/\.(example\.(org|net|com)|test|invalid)$/);
  });
});
describe("compose.coolify.yaml", () => {
  it("reaches the web server under the alias that the Traefik file names, and routes nothing by labels", () => {
    expect(routing).toContain("http://aidesk-app:3000");
    expect(compose).toContain("aliases: [aidesk-app]");
    expect(compose).toContain("- traefik.enable=false");
    expect(compose).not.toMatch(/traefik\.http\./);
  });
  it("builds the image itself and publishes no port", () => {
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).toContain("pull_policy: never");
    expect(compose).toContain("target: production");
  });
});
describe("the names that the web server reaches in compose.coolify.yaml", () => {
  // The web server joins the network `coolify`, which every resource of the instance shares; Docker resolves a
  // bare `postgres` there to the database of Coolify itself, so the web server and the worker asked it for a
  // login with the credentials of this product. The names carry a prefix that no other resource has.
  const services = compose.slice(compose.indexOf("\nservices:"), compose.indexOf("\nnetworks:"));
  const names = [...services.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map(
    (found) => found[1] ?? "",
  );
  const hostOf = (pattern: RegExp): string => pattern.exec(compose)?.[1] ?? "";
  it("are services of this file with a prefix", () => {
    const hosts = [
      hostOf(/@([a-z0-9-]+):5432\//),
      hostOf(/S3_ENDPOINT: http:\/\/([a-z0-9-]+):9000/),
    ];
    for (const host of hosts) {
      expect(host).toMatch(/^aidesk-/);
      expect(names).toContain(host);
    }
  });
  it("are not names that other resources of an instance commonly have", () => {
    for (const generic of ["postgres", "storage", "db", "database", "redis", "minio", "mysql"])
      expect(names, generic).not.toContain(generic);
  });
});
