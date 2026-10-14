import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hostRefused } from "../domain/hosts";
const resolveTimeout = 5_000;
// Whether a host may be used by a connection: a name is resolved and every
// address it resolves to has to be allowed, so a name that points at the
// machine itself or at the link-local range is refused as well. A name that does
// not resolve is refused. The check is made when a connection is saved and when
// it is tested; an address that changes after that is caught by the next test.
export type HostVerdict = "allowed" | "refused" | "unresolved";
export async function checkHost(host: string): Promise<HostVerdict> {
  if (hostRefused(host)) return "refused";
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) return "allowed";
  let addresses: { address: string }[];
  try {
    addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("timeout"));
        }, resolveTimeout).unref();
      }),
    ]);
  } catch {
    return "unresolved";
  }
  if (addresses.length === 0) return "unresolved";
  return addresses.some((entry) => hostRefused(entry.address)) ? "refused" : "allowed";
}
// Whether this is the development stack, which may use plain and local endpoints
// that a production stack refuses.
export const developmentStack = () =>
  process.env.NODE_ENV === "development" && process.env.DEV_BOOTSTRAP === "true";
