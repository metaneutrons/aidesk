import { z } from "zod";
import { actions } from "./permissions";
// The invitation of an operator by address: a person who manages a project adds a person by name and address with
// the actions they hold in it, and the person is told by mail. The mail carries no password and no link that signs
// in; the person signs in as every operator does, through the provider of their organization.
export const invitationInput = z
  .object({
    email: z.email().max(254),
    name: z.string().trim().min(1).max(100),
    actions: z
      .array(z.enum(actions))
      .max(actions.length)
      .transform((values) => [...new Set(values)]),
    language: z.enum(["en", "de"]).optional(),
    sendMail: z.boolean().default(true),
  })
  .strict();
export const invitationOut = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  created: z.boolean().describe("false when the address already belonged to an operator"),
  actions: z.array(z.string()).describe("What the person holds in the project now"),
  mail: z.enum(["queued", "skipped", "no_connection", "paused"]),
  mailId: z.string().nullable().describe("Follow it at GET /test-mails/{id}"),
  canSignIn: z
    .boolean()
    .describe(
      "Whether a provider with a verified domain exists for the address; without one the person cannot sign in yet",
    ),
});
export const invitationsPerDay = 20;
export const invitationSubject = (language: "en" | "de", project: string) =>
  language === "de" ? `Du wurdest zu ${project} hinzugefügt` : `You were added to ${project}`;
export function invitationMarkdown(
  language: "en" | "de",
  values: { name: string; inviter: string; project: string; url: string },
): string {
  return language === "de"
    ? `Hallo ${values.name},\n\n${values.inviter} hat dich als Operator für ${values.project} in aidesk eingetragen. Melde dich dort mit dem Konto deiner Organisation an: ${values.url}\n\nDiese Mail teilt nur den Zugang mit. Sie enthält kein Passwort und keinen Link, der dich anmeldet.`
    : `Hello ${values.name},\n\n${values.inviter} added you as an operator of ${values.project} in aidesk. Sign in with the account of your organization: ${values.url}\n\nThis mail only tells you about the access. It contains no password and no link that signs you in.`;
}
