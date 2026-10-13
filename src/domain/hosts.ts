// Hosts that a connection defined through the API may not point at: the
// machine itself and the link-local range that holds cloud metadata services.
// Private networks stay allowed, because a mail server of one's own is often on
// one. A literal address is checked here; a name is not resolved, so this limits
// mistakes and casual probing, and does not replace network policy.
export function hostRefused(host: string): boolean {
  const name = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "metadata.google.internal") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    return first === 0 || first === 127 || (first === 169 && second === 254);
  }
  if (name.includes(":")) {
    if (name === "::" || name === "::1") return true;
    return /^fe[89ab]/.test(name);
  }
  return false;
}
