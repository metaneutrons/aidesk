import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { portalHostMayServe } from "../src/domain/portal-domains";
// The Traefik labels of compose.coolify.yaml route the customer pages by path, and the application checks the
// same list again. A path that the application serves on a customer name but that the labels do not pass would
// be a page that never loads, and a path that the labels pass but the application refuses is only a second
// line of defence that no longer is one. The desk must stay behind its address ranges.
const compose = readFileSync(new URL("../compose.coolify.yaml", import.meta.url), "utf8");
const label = (key: string): string => {
  const line = compose.split("\n").find((entry) => entry.trim().startsWith(`- ${key}=`));
  if (line === undefined) throw new Error(`no label ${key}`);
  return line.trim().slice(`- ${key}=`.length);
};
const portalRule = label("traefik.http.routers.aidesk-portal.rule");
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
describe("the routes of the customer pages in compose.coolify.yaml", () => {
  it("find at least one matcher", () => {
    expect(matchers.length).toBeGreaterThan(0);
  });
  it("pass what the application serves on a customer name", () => {
    for (const path of served) {
      expect(portalHostMayServe(path), `application: ${path}`).toBe(true);
      expect(passes(path), `labels: ${path}`).toBe(true);
    }
  });
  it("refuse what the application refuses on a customer name", () => {
    for (const path of refused) {
      expect(portalHostMayServe(path), `application: ${path}`).toBe(false);
      expect(passes(path), `labels: ${path}`).toBe(false);
    }
  });
  it("route nothing without a rule of the operator", () => {
    expect(portalRule).toContain("${PORTAL_HOST_RULE:-Host(`portal.invalid`)}");
  });
});
describe("the route of the desk in compose.coolify.yaml", () => {
  it("is one name from the variable and goes through the address ranges, and the customer pages do not", () => {
    expect(label("traefik.http.routers.aidesk-desk.rule")).toMatch(
      /^Host\(`\$\{DESK_HOST:\?[^}]*\}`\)$/,
    );
    expect(label("traefik.http.routers.aidesk-desk.middlewares")).toContain(
      "aidesk-desk-only@docker",
    );
    expect(label("traefik.http.routers.aidesk-portal.middlewares")).not.toContain(
      "aidesk-desk-only",
    );
  });
  it("allows private and local ranges by default and no public one", () => {
    const ranges = /\$\{DESK_ALLOWED_RANGES:-([^}]*)\}/
      .exec(label("traefik.http.middlewares.aidesk-desk-only.ipallowlist.sourcerange"))?.[1]
      ?.split(",");
    expect(ranges).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "fc00::/7",
      "127.0.0.1/32",
      "::1/128",
    ]);
  });
});
describe("the services in compose.coolify.yaml", () => {
  it("build the image themselves and publish no port", () => {
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).toContain("pull_policy: never");
    expect(compose).toContain("target: production");
  });
});
