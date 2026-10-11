export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  const base = new URL("https://aidesk.invalid");
  try {
    const target = new URL(value, base);
    return target.origin === base.origin ? target.pathname + target.search + target.hash : "/";
  } catch {
    return "/";
  }
}
