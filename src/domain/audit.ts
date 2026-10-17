import { z } from "zod";
// The filter of the audit list and export. `action` names one action, or a family when it ends with a dot
// (`ticket.` is every action of a ticket). `actor` and `target` are the identifiers that the entries hold.
// `before` is the cursor of the previous page, which the server hands out and the client returns unchanged.
export const auditFilter = z.object({
  actor: z.string().trim().min(1).max(100).optional().describe("The person or token that acted"),
  action: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_.]+$/)
    .optional()
    .describe("One action, or a family of actions when it ends with a dot, for example ticket."),
  target: z.string().trim().min(1).max(100).optional().describe("The object that was acted on"),
  from: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("Entries at or after this time (ISO 8601)"),
  to: z.iso.datetime({ offset: true }).optional().describe("Entries before this time (ISO 8601)"),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe("Entries per page"),
  before: z.string().max(200).optional().describe("The cursor of the previous page"),
});
export type AuditFilter = z.infer<typeof auditFilter>;
// The largest export, in entries. An export that is cut says so in its last line.
export const auditExportLimit = 10_000;
// What the list and the export show of the `detail` of an entry. The entries are written without ticket
// content, secrets and customer addresses; what can still get in is a URL with credentials or a token in its
// query (an endpoint or a webhook address is typed by a person), a long free text, and the login name of a
// mailbox. This is applied to every entry that is read, old ones included, and to what is written for the
// changes that carry such values, so that the database does not hold them either.
const textLimit = 200;
const withheld = "[withheld]";
const secretKey = /secret|token|password|passcode|api_?key|authorization|credential/i;
function plainUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return value;
  }
}
function cut(value: string): string {
  const text = plainUrl(value);
  return text.length > textLimit ? `${text.slice(0, textLimit)}…` : text;
}
export function redactDetail(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return cut(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return withheld;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactDetail(item, depth + 1));
  const entry = value as Record<string, unknown>;
  // The login name of a mailbox is withheld; that it changed stays visible.
  if (typeof entry.pointer === "string" && entry.pointer.endsWith("/config/user"))
    return { pointer: entry.pointer, from: withheld, to: withheld };
  return Object.fromEntries(
    Object.entries(entry).map(([key, inner]) => [
      key,
      secretKey.test(key) && typeof inner === "string" && !/^(set|unset|replaced)$/.test(inner)
        ? withheld
        : redactDetail(inner, depth + 1),
    ]),
  );
}
export const redactRecord = (detail: Record<string, unknown>): Record<string, unknown> =>
  redactDetail(detail) as Record<string, unknown>;
