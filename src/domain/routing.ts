import { z } from "zod";
import { normalizePattern } from "./sender-rules";
import { maxCategoryLength, priorities } from "./triage";
// How a project routes a new ticket. The rules are tried in order and the first enabled one that matches wins. A
// rule matches when every condition it names holds: the sender is one of the listed addresses or domains (a domain
// covers its subdomains), the language is one of the listed, the subject has one of the listed words (any case,
// anywhere in the subject). A rule without conditions matches every ticket, and is the default when it comes last.
// A matching rule can hand the ticket to a person, to the members of a group in turn or to an agent, and can set the
// priority and the category. A new ticket has no tags yet, so tags are no condition.
export const maxRoutingRules = 50;
export const maxConditionValues = 20;
const word = z.string().trim().min(1).max(60);
const sender = z
  .string()
  .max(320)
  .transform((value, context) => {
    const found = normalizePattern(value);
    if (!found) {
      context.addIssue({ code: "custom", message: "An address or a domain" });
      return z.NEVER;
    }
    return found.value;
  });
const language = z.string().regex(/^[a-z]{2,3}$/);
export const routingConditions = z
  .object({
    senders: z.array(sender).max(maxConditionValues).default([]),
    languages: z.array(language).max(maxConditionValues).default([]),
    subjectWords: z.array(word).max(maxConditionValues).default([]),
  })
  .strict();
export const routingTarget = z
  .object({ kind: z.enum(["user", "group", "agent"]), id: z.string().min(1).max(100) })
  .strict();
export const routingRuleInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    conditions: routingConditions.default({ senders: [], languages: [], subjectWords: [] }),
    target: routingTarget.nullable().default(null),
    priority: z.enum(priorities).nullable().default(null),
    category: z.string().trim().min(1).max(maxCategoryLength).nullable().default(null),
  })
  .strict()
  .refine((rule) => rule.target !== null || rule.priority !== null || rule.category !== null, {
    message: "A rule hands the ticket to someone or sets a priority or a category",
    path: ["target"],
  });
export type RoutingRuleInput = z.infer<typeof routingRuleInput>;
export const routingOrder = z
  .object({ ids: z.array(z.uuid()).min(1).max(maxRoutingRules) })
  .strict()
  .refine(({ ids }) => new Set(ids).size === ids.length);
export interface RoutingConditions {
  senders: readonly string[];
  languages: readonly string[];
  subjectWords: readonly string[];
}
export interface RoutedMail {
  sender: string;
  language: string;
  subject: string;
}
const senderMatches = (pattern: string, address: string) => {
  const found = address.trim().toLowerCase();
  return pattern.includes("@")
    ? pattern === found
    : (() => {
        const domain = found.slice(found.lastIndexOf("@") + 1);
        return domain === pattern || domain.endsWith(`.${pattern}`);
      })();
};
export function matches(conditions: RoutingConditions, mail: RoutedMail): boolean {
  if (
    conditions.senders.length > 0 &&
    !conditions.senders.some((pattern) => senderMatches(pattern, mail.sender))
  )
    return false;
  if (conditions.languages.length > 0 && !conditions.languages.includes(mail.language))
    return false;
  const subject = mail.subject.toLowerCase();
  return (
    conditions.subjectWords.length === 0 ||
    conditions.subjectWords.some((entry) => subject.includes(entry.toLowerCase()))
  );
}
// The first enabled rule, in the order given, that matches.
export function firstMatch<T extends { enabled: boolean; conditions: RoutingConditions }>(
  rules: readonly T[],
  mail: RoutedMail,
): T | null {
  return rules.find((rule) => rule.enabled && matches(rule.conditions, mail)) ?? null;
}
// The member of a group that gets the next ticket: the eligible members in a fixed order, taken in turn.
export const nextMember = (members: readonly string[], cursor: number): string | null =>
  members.length === 0
    ? null
    : ([...members].sort()[((cursor % members.length) + members.length) % members.length] ?? null);
export const routingRuleOut = z.object({
  id: z.uuid(),
  position: z.number(),
  name: z.string(),
  enabled: z.boolean(),
  conditions: z.object({
    senders: z.array(z.string()),
    languages: z.array(z.string()),
    subjectWords: z.array(z.string()),
  }),
  target: z
    .object({
      kind: z.enum(["user", "group", "agent"]),
      id: z.string(),
      name: z.string().nullable(),
    })
    .nullable(),
  priority: z.enum(priorities).nullable(),
  category: z.string().nullable(),
  createdAt: z.string(),
});
export const routingTargetsOut = z.object({
  users: z.array(z.object({ id: z.string(), name: z.string() })),
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
  agents: z.array(z.object({ id: z.string(), name: z.string(), managed: z.boolean() })),
});
