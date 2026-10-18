import { z } from "zod";
// The names under which the customer page of a project is reached next to the shared address. Only the
// shape of a name and the rules of a name that serves the page are here; the claim, the proof and the
// lookup are in the server module.
const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const hostPattern = new RegExp(`^(?:${label}\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`);
// A name of the kind that a customer types: lower case letters, digits and hyphens in labels, at least
// two labels, no port, no address of a machine, no path.
export const hostName = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine((value) => hostPattern.test(value), { message: "Not a host name" })
  .refine((value) => !/\.(local|localhost|internal|invalid)$/.test(value), {
    message: "Not a public name",
  });
export const portalDomainInput = z.object({ host: hostName }).strict();
// What the owner of the name puts into the DNS to prove it: a text record under this name holding this value.
export const challengeName = (host: string): string => `_aidesk-challenge.${host}`;
export const challengeValue = (token: string): string => `aidesk-verify=${token}`;
// A name that serves the customer page serves nothing else: not the desk, not the API, not the sign-in.
// These are the paths that it answers; every other path is not found there.
export function portalHostMayServe(pathname: string): boolean {
  return (
    pathname === "/portal" ||
    pathname.startsWith("/portal/") ||
    pathname.startsWith("/api/portal/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/icon.svg" ||
    pathname === "/robots.txt"
  );
}
// The host of a request without its port, in lower case; the first of a list that a proxy hands on.
export function hostOf(value: string | null | undefined): string | null {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  if (!first) return null;
  const withoutPort = first.replace(/:\d+$/, "");
  return withoutPort || null;
}
