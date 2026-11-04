import type { NotificationKind } from "./notifications";
// The mail that tells an operator about a notification: the kind, the number and the subject of the ticket, and a link
// to it, and nothing else. The subject is text of a customer; it is cut and written so that it can neither add a line to
// the header nor a link or a format to the body.
const subjectCeiling = 150;
export const cleanSubject = (value: string): string =>
  value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, subjectCeiling);
// Marks of Markdown and of HTML are written as text.
export const plainText = (value: string): string =>
  cleanSubject(value).replace(/[\\`*_{}[\]()#+\-.!|<>~&]/g, "\\$&");
const headline: Record<"en" | "de", Record<NotificationKind, string>> = {
  en: {
    new_ticket: "New ticket",
    assignment: "Assigned to you",
    mention: "You were mentioned",
    overdue: "Overdue",
    draft: "A draft waits for you",
  },
  de: {
    new_ticket: "Neues Ticket",
    assignment: "Dir zugewiesen",
    mention: "Du wurdest erwähnt",
    overdue: "Überfällig",
    draft: "Ein Entwurf wartet auf dich",
  },
};
export interface NotificationMailValues {
  project: string;
  number: number | null;
  subject: string;
  url: string;
}
const ticket = (values: NotificationMailValues) =>
  `${values.number === null ? "" : `#${String(values.number)} `}${cleanSubject(values.subject)}`;
export const notificationMailSubject = (
  language: "en" | "de",
  kind: NotificationKind,
  values: NotificationMailValues,
): string => `[${cleanSubject(values.project)}] ${headline[language][kind]}: ${ticket(values)}`;
export function notificationMailMarkdown(
  language: "en" | "de",
  kind: NotificationKind,
  values: NotificationMailValues,
): string {
  const line = `**${headline[language][kind]}** · ${plainText(values.project)}`;
  const about = `${values.number === null ? "" : `#${String(values.number)} `}${plainText(values.subject)}`;
  const open = language === "de" ? "Ticket öffnen" : "Open the ticket";
  const note =
    language === "de"
      ? "Diese Mail nennt nur Art, Nummer und Betreff des Tickets. Was ankommt, stellst du in aidesk unter Einstellungen ein."
      : "This mail names only the kind, the number and the subject of the ticket. You choose what reaches you in aidesk under Settings.";
  return `${line}\n\n${about}\n\n[${open}](${values.url})\n\n${note}`;
}
