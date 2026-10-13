// Hosts that a connection defined through the API may not point at: the
// machine itself and the link-local range that holds cloud metadata services.
// Private networks stay allowed, because a mail server of one's own is often on
// one. This checks a name or an address as written; a name is resolved by the
// server (host-guard.ts) and every address it resolves to is checked here too.
// An address in IPv4-mapped IPv6 form (::ffff:127.0.0.1 or ::ffff:7f00:1) is the
// IPv4 address it carries.
function mappedV4(address: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (dotted) return dotted[1] ?? null;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!hex) return null;
  const high = parseInt(hex[1] ?? "0", 16);
  const low = parseInt(hex[2] ?? "0", 16);
  return `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`;
}
export function hostRefused(host: string): boolean {
  let name = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "metadata.google.internal") return true;
  if (name.includes(":")) {
    // The canonical form turns 0:0:0:0:0:0:0:1 into ::1.
    try {
      name = new URL(`http://[${name}]`).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return true;
    }
    const mapped = mappedV4(name);
    if (mapped) return hostRefused(mapped);
    if (name === "::" || name === "::1") return true;
    return /^fe[89ab]/.test(name);
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    return first === 0 || first === 127 || (first === 169 && second === 254);
  }
  return false;
}
