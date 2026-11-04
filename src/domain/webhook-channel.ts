import { cleanSubject } from "./notification-mail";
import type { ChannelFormat } from "./webhooks";
// The message that a channel of a messenger gets: the kind of event, the number of the ticket and a link, and the
// subject only when the channel is set to name it. The text is made here for each format, in the language of the
// project. The subject is text of a customer, so it is cut and cleaned like in the mail of a notification, the marks of
// the format of the messenger are written as text, and a mention in it is broken (an `@` is followed by a zero-width
// space), so that a subject can neither format the message, nor hide a link behind a text, nor call a person or a whole
// channel. A bare address in a subject stays text, which a messenger may show as a link.
export type ChannelKind =
  "created" | "assigned" | "overdue" | "draft" | "resolved" | "reopened" | "changed" | "ping";
export type ChannelLanguage = "en" | "de";
export interface ChannelValues {
  kind: ChannelKind;
  language: ChannelLanguage;
  project: string;
  number: number | null;
  // The subject of the ticket, or null when the channel does not name it.
  subject: string | null;
  // The link to the ticket, or null for a test message.
  url: string | null;
}
const headline: Record<ChannelLanguage, Record<ChannelKind, string>> = {
  en: {
    created: "New ticket",
    assigned: "Ticket assigned",
    overdue: "Ticket overdue",
    draft: "A draft waits for a person",
    resolved: "Ticket resolved",
    reopened: "Ticket reopened",
    changed: "Ticket changed",
    ping: "Test message",
  },
  de: {
    created: "Neues Ticket",
    assigned: "Ticket zugewiesen",
    overdue: "Ticket überfällig",
    draft: "Ein Entwurf wartet auf eine Person",
    resolved: "Ticket gelöst",
    reopened: "Ticket wieder geöffnet",
    changed: "Ticket geändert",
    ping: "Testnachricht",
  },
};
const openLabel: Record<ChannelLanguage, string> = {
  en: "Open the ticket",
  de: "Ticket öffnen",
};
const pingNote: Record<ChannelLanguage, string> = {
  en: "This channel receives notifications of this project from aidesk.",
  de: "Dieser Kanal erhält Benachrichtigungen zu diesem Projekt von aidesk.",
};
// A mention needs the name right behind the `@`; the zero-width space (U+200B) separates them.
const breakMentions = (value: string): string => value.replace(/@/g, "@​");
// Marks of Markdown (and the characters that HTML and Slack read) are written as text.
const markdownText = (value: string): string =>
  breakMentions(cleanSubject(value)).replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, "\\$&");
// Slack reads `&`, `<` and `>` as the start of a mention or a link and asks for them to be written as entities.
const slackText = (value: string): string =>
  breakMentions(cleanSubject(value))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const plain = (value: string): string => breakMentions(cleanSubject(value));
const ticketLine = (values: ChannelValues, text: (value: string) => string): string => {
  const number = values.number === null ? "" : `#${String(values.number)}`;
  const subject = values.subject === null ? "" : text(values.subject);
  return [number, subject].filter((part) => part !== "").join(" ");
};
const head = (values: ChannelValues): string => headline[values.language][values.kind];
const adaptiveVersion = "1.2";
// The body of a delivery for the incoming webhook of a messenger, as the messenger documents it: Slack takes `text`,
// Teams (a workflow with the trigger "When a Teams webhook request is received") an Adaptive Card in a message,
// Discord `content`, Mattermost `text` in Markdown, Rocket.Chat `text` and attachments, Apprise (its API) a title and a
// body with a type and a format.
export function channelBody(format: ChannelFormat, values: ChannelValues): Record<string, unknown> {
  const link = values.url;
  const label = openLabel[values.language];
  const project = (text: (value: string) => string) => text(values.project);
  switch (format) {
    case "slack": {
      const lines = [`*${head(values)}* · ${project(slackText)}`];
      if (values.kind === "ping") lines.push(pingNote[values.language]);
      else {
        const line = ticketLine(values, slackText);
        if (line) lines.push(line);
      }
      if (link) lines.push(`<${link}|${label}>`);
      return { text: lines.join("\n") };
    }
    case "teams": {
      const body: Record<string, unknown>[] = [
        { type: "TextBlock", text: `**${head(values)}** · ${project(markdownText)}`, wrap: true },
      ];
      const line =
        values.kind === "ping" ? pingNote[values.language] : ticketLine(values, markdownText);
      if (line) body.push({ type: "TextBlock", text: line, wrap: true });
      if (link) body.push({ type: "TextBlock", text: `[${label}](${link})`, wrap: true });
      return {
        type: "message",
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            contentUrl: null,
            content: {
              $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
              type: "AdaptiveCard",
              version: adaptiveVersion,
              body,
            },
          },
        ],
      };
    }
    case "discord":
    case "mattermost": {
      const lines = [`**${head(values)}** · ${project(markdownText)}`];
      const line =
        values.kind === "ping" ? pingNote[values.language] : ticketLine(values, markdownText);
      if (line) lines.push(line);
      if (link) lines.push(`[${label}](${link})`);
      return format === "discord"
        ? // An empty list of kinds to parse means that nothing in the text calls anybody.
          { content: lines.join("\n"), allowed_mentions: { parse: [] } }
        : { text: lines.join("\n") };
    }
    case "rocketchat": {
      const text = `${head(values)} · ${project(plain)}`;
      if (values.kind === "ping") return { text: `${text}\n${pingNote[values.language]}` };
      // The documentation does not say whether the title of an attachment reads Markdown, so it is written as text.
      const line = ticketLine(values, markdownText);
      return {
        text,
        attachments: [
          {
            title: line || head(values),
            ...(link ? { title_link: link } : {}),
          },
        ],
      };
    }
    case "apprise": {
      const lines: string[] = [];
      const line =
        values.kind === "ping" ? pingNote[values.language] : ticketLine(values, markdownText);
      if (line) lines.push(line);
      if (link) lines.push(`[${label}](${link})`);
      return {
        title: `${head(values)} · ${plain(values.project)}`,
        body: lines.join("\n\n") || head(values),
        type:
          values.kind === "overdue" ? "warning" : values.kind === "resolved" ? "success" : "info",
        format: "markdown",
      };
    }
  }
}
// The kind of a message for an event; null for an event that no channel gets.
export function channelKindOf(type: string, data: Record<string, unknown>): ChannelKind | null {
  switch (type) {
    case "ping":
      return "ping";
    case "ticket.created":
      return "created";
    case "ticket.assigned":
      return "assigned";
    case "ticket.overdue":
      return "overdue";
    case "draft.created":
      return "draft";
    case "ticket.status_changed":
      return data.to === "resolved"
        ? "resolved"
        : data.from === "resolved"
          ? "reopened"
          : "changed";
    default:
      return null;
  }
}
