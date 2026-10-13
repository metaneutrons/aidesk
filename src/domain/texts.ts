import english from "../i18n/en.json";
import german from "../i18n/de.json";
// The wording a project may set for itself: the mail that acknowledges a new
// ticket, the line that leads to the ticket page in a mail, and the texts of
// the customer page. Each key has built-in wording in English and German, which
// stays in use wherever a project sets none. A text may contain {placeholders}
// of its key and no other braces.
export const textLanguages = ["en", "de"] as const;
export type TextLanguage = (typeof textLanguages)[number];
export const maxTextLength = 2000;
export interface TextKey {
  description: string;
  placeholders: readonly string[];
  required: readonly string[];
  defaults: Record<TextLanguage, string>;
}
const catalog = { en: english as Record<string, string>, de: german as Record<string, string> };
const fromCatalog = (key: string): Record<TextLanguage, string> => ({
  en: catalog.en[key] ?? "",
  de: catalog.de[key] ?? "",
});
export const textKeys = {
  acknowledgement: {
    description: "The mail that acknowledges a new ticket to the customer",
    placeholders: ["number"],
    required: ["number"],
    defaults: {
      en:
        "We have received your message and recorded it as #{number}. " +
        "We will reply as soon as we have looked into it.\n\n" +
        "If you would like to add anything, simply reply to this email.",
      de:
        "Wir haben deine Nachricht erhalten und unter der Nummer #{number} erfasst. " +
        "Wir antworten dir, sobald wir sie bearbeitet haben.\n\n" +
        "Wenn du etwas ergänzen möchtest, antworte einfach auf diese E-Mail.",
    },
  },
  portalLink: {
    description: "The line in a mail that leads to the ticket page; the link follows it",
    placeholders: [],
    required: [],
    defaults: {
      en: "View this request online and reply:",
      de: "Diese Anfrage online ansehen und antworten:",
    },
  },
  "portal.request": {
    description: "Heading of the ticket page",
    placeholders: ["number"],
    required: ["number"],
    defaults: fromCatalog("portalRequest"),
  },
  "portal.conversation": {
    description: "Heading above the messages of the ticket page",
    placeholders: [],
    required: [],
    defaults: fromCatalog("portalConversation"),
  },
  "portal.you": {
    description: "How the customer's own messages are labelled",
    placeholders: [],
    required: [],
    defaults: fromCatalog("portalYou"),
  },
  "portal.reply": {
    description: "Label of the reply field",
    placeholders: [],
    required: [],
    defaults: fromCatalog("portalReply"),
  },
  "portal.send": {
    description: "Label of the button that sends a reply",
    placeholders: [],
    required: [],
    defaults: fromCatalog("portalSend"),
  },
  "portal.closed": {
    description: "Shown instead of the reply field when the request is closed",
    placeholders: [],
    required: [],
    defaults: fromCatalog("portalClosed"),
  },
  "portal.limited": {
    description: "Shown when a customer sends too many replies in a short time",
    placeholders: [],
    required: [],
    defaults: fromCatalog("portalLimited"),
  },
  "portal.failed": {
    description: "Shown when a reply could not be sent",
    placeholders: [],
    required: [],
    defaults: fromCatalog("portalFailed"),
  },
} as const satisfies Record<string, TextKey>;
export type TextKeyName = keyof typeof textKeys;
export const textKeyNames = Object.keys(textKeys) as TextKeyName[];
export function isTextKey(value: string): value is TextKeyName {
  return value in textKeys;
}
export function isTextLanguage(value: string): value is TextLanguage {
  return (textLanguages as readonly string[]).includes(value);
}
// The built-in language a recipient's language is served in.
export function baseLanguage(language: string): TextLanguage {
  return language.toLowerCase().startsWith("de") ? "de" : "en";
}
// What is wrong with a text for a key; empty when it can be used.
export function textProblems(key: TextKeyName, text: string): string[] {
  const entry: TextKey = textKeys[key];
  const problems: string[] = [];
  if (text.trim() === "") problems.push("The text is empty");
  if (text.length > maxTextLength)
    problems.push(`The text is longer than ${String(maxTextLength)} characters`);
  const used = new Set<string>();
  for (const found of text.matchAll(/\{([^{}]*)\}/g)) {
    const name = found[1] ?? "";
    if (entry.placeholders.includes(name)) used.add(name);
    else problems.push(`{${name}} is not a placeholder of ${key}`);
  }
  // Braces that do not belong to a placeholder would be read as markup.
  if (/[{}]/.exec(text.replace(/\{[^{}]*\}/g, ""))) problems.push("Unmatched braces");
  // The customer page reads its texts as ICU messages, where an apostrophe next
  // to a brace quotes it.
  if (/'[{}]|[{}]'/.test(text)) problems.push("An apostrophe next to a placeholder is not allowed");
  for (const name of entry.required) if (!used.has(name)) problems.push(`{${name}} is required`);
  return problems;
}
export function fillText(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([^{}]*)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}
// The text in use: the project's own, or else the built-in wording.
export function effectiveText(
  key: TextKeyName,
  language: string,
  overrides: Partial<Record<string, string>>,
): string {
  const entry: TextKey = textKeys[key];
  return overrides[key] ?? entry.defaults[baseLanguage(language)];
}
// The i18n key of the customer page that a text replaces.
export const portalMessageKeys: Record<string, string> = {
  "portal.request": "portalRequest",
  "portal.conversation": "portalConversation",
  "portal.you": "portalYou",
  "portal.reply": "portalReply",
  "portal.send": "portalSend",
  "portal.closed": "portalClosed",
  "portal.limited": "portalLimited",
  "portal.failed": "portalFailed",
};
