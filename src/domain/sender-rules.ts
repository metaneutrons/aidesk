import { z } from "zod";
// The lists of a project: senders that are always taken ("allow") and senders that are always kept out as junk
// ("block"). A rule names an address (`kim@example.org`) or a domain (`example.org`, which also covers its
// subdomains). A rule for an address wins over a rule for a domain, so one address of a blocked domain can be
// allowed, and one address of an allowed domain can be blocked. A name is in the lists once.
export const senderRuleKinds = ["allow", "block"] as const;
export type SenderRuleKind = (typeof senderRuleKinds)[number];
export const maxSenderRules = 500;
const domainPattern = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const addressPattern = /^[a-z0-9._%+'-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// What a person types, as a rule: an address, a domain, or a domain with a leading `@`.
export function normalizePattern(
  value: string,
): { type: "address" | "domain"; value: string } | null {
  const text = value.trim().toLowerCase().replace(/^\*?@/, "");
  if (addressPattern.test(text)) return { type: "address", value: text };
  if (domainPattern.test(text)) return { type: "domain", value: text };
  return null;
}
export const senderRuleInput = z
  .object({
    kind: z.enum(senderRuleKinds),
    value: z
      .string()
      .max(320)
      .transform((value, context) => {
        const found = normalizePattern(value);
        if (!found) {
          context.addIssue({
            code: "custom",
            message: "An address like kim@example.org or a domain like example.org",
          });
          return z.NEVER;
        }
        return found;
      }),
    note: z.string().trim().max(200).optional(),
  })
  .strict();
export interface SenderRuleRow {
  kind: SenderRuleKind;
  type: "address" | "domain";
  value: string;
}
// The rule that applies to a sender, or none: an address rule first, then the rule of the longest domain that the
// address belongs to (the domain itself or one of its parents).
export function matchSender<T extends SenderRuleRow>(
  rules: readonly T[],
  address: string,
): T | null {
  const sender = address.trim().toLowerCase();
  const exact = rules.find((rule) => rule.type === "address" && rule.value === sender);
  if (exact) return exact;
  const domain = sender.slice(sender.lastIndexOf("@") + 1);
  let best: T | null = null;
  for (const rule of rules) {
    if (rule.type !== "domain") continue;
    if (domain === rule.value || domain.endsWith(`.${rule.value}`))
      if (!best || rule.value.length > best.value.length) best = rule;
  }
  return best;
}
export const senderRuleOut = z.object({
  id: z.uuid(),
  kind: z.enum(senderRuleKinds),
  type: z.enum(["address", "domain"]),
  value: z.string(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
