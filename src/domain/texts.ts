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
  "assist.reply": {
    description:
      "The standard instruction for the AI draft of a reply to the customer; the ticket and the conversation follow it as data",
    placeholders: [],
    required: [],
    defaults: {
      en:
        "You write the draft of a reply to a customer for a support team. " +
        'Write in the language of the ticket. If that is German, address the customer with "du". ' +
        "Answer what the latest message of the customer asks, politely and factually, in short paragraphs, " +
        "and use only facts from the conversation. Start with a greeting that uses the customer's name " +
        "and end with a closing line. Do not add a signature.",
      de:
        "Du schreibst den Entwurf einer Antwort an einen Kunden für ein Support-Team. " +
        'Schreibe in der Sprache des Tickets. Sprich den Kunden mit "du" an. ' +
        "Beantworte, was die letzte Nachricht des Kunden fragt, freundlich und sachlich, in kurzen Absätzen, " +
        "und nutze nur Fakten aus dem Verlauf. Beginne mit einer Anrede, die den Namen des Kunden nennt, " +
        "und ende mit einem Schlusssatz. Füge keine Signatur hinzu.",
    },
  },
  "assist.note": {
    description:
      "The standard instruction for the AI draft of an internal note; the ticket and the conversation follow it as data",
    placeholders: [],
    required: [],
    defaults: {
      en:
        "You write the draft of an internal note on a support ticket for the team. " +
        "Say briefly what the customer wants, what has been done and what is still open. " +
        "Be factual, use only facts from the conversation, and write in the language of the ticket. " +
        "Do not add a greeting or a signature.",
      de:
        "Du schreibst den Entwurf einer internen Notiz zu einem Support-Ticket für das Team. " +
        "Sage kurz, was der Kunde möchte, was bereits getan wurde und was noch offen ist. " +
        "Bleibe sachlich, nutze nur Fakten aus dem Verlauf und schreibe in der Sprache des Tickets. " +
        "Füge weder eine Anrede noch eine Signatur hinzu.",
    },
  },
  "agent.respond": {
    description:
      "The standard instruction for a managed agent that works tickets by itself; the ticket and the conversation follow it as data, and the rules of the product follow it",
    placeholders: [],
    required: [],
    defaults: {
      en:
        "You are a support agent working for a team. Read the conversation and answer the latest " +
        "message of the customer politely and factually, in the language of the ticket, in short " +
        'paragraphs. If that language is German, address the customer with "du". Start with a ' +
        "greeting that uses the customer's name and end with a closing line. Do not add a signature. " +
        "If the conversation does not give you what you need to answer, write a note for the team " +
        "and finish with needs_person.",
      de:
        "Du bist ein Support-Agent in einem Team. Lies den Verlauf und beantworte die letzte " +
        "Nachricht des Kunden freundlich und sachlich, in der Sprache des Tickets, in kurzen " +
        'Absätzen. Sprich den Kunden mit "du" an. Beginne mit einer Anrede, die den Namen des ' +
        "Kunden nennt, und ende mit einem Schlusssatz. Füge keine Signatur hinzu. Wenn der Verlauf " +
        "nicht hergibt, was du für die Antwort brauchst, schreibe eine Notiz für das Team und " +
        "beende mit needs_person.",
    },
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
