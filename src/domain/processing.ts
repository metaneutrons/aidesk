import { z } from "zod";
import type { AiTask } from "./ai";
// What the processing overview of a project says: where the content of its tickets goes. Each entry is a connection,
// a model or a webhook that receives content of tickets, the address it is reached at, what it receives, and what is
// missing or off. The content classes are named for the records of processing; the desk writes them out in words.
export const contentClasses = [
  // The messages of a conversation between the team and the customer.
  "conversation",
  // The internal notes of the team, which only a note draft reads.
  "notes",
  // The text that a person has typed into the composer so far.
  "typed_text",
  // The subject, the name and the address of the customer.
  "subject",
  "customer_name",
  "customer_address",
  // The first part of a mail or the text of one message.
  "mail_text",
  "message_text",
  // The images and documents of a conversation.
  "attachment_images",
  "attachment_text",
  // Words for a search, and the address of a customer for a source that knows customers.
  "search_words",
  // The standard texts of a project.
  "template_text",
  // The ticket numbers, ids and status facts of an event; no message content.
  "event_facts",
  // The raw mail, stored where it arrives.
  "raw_mail",
] as const;
export type ContentClass = (typeof contentClasses)[number];
// What a task of a model gets. The tool calls of an agent bring more as it works: its tools are listed with it.
export const taskContent: Record<AiTask, readonly ContentClass[]> = {
  "reply.draft": ["conversation", "typed_text", "subject", "customer_name", "template_text"],
  "note.draft": ["conversation", "notes", "typed_text", "subject", "customer_name"],
  "image.read": ["attachment_images"],
  "agent.respond": [
    "conversation",
    "subject",
    "customer_name",
    "attachment_text",
    "search_words",
    "template_text",
  ],
  "intake.extract": ["mail_text"],
  "intake.junk": ["mail_text", "subject", "customer_address"],
  "message.translate": ["message_text"],
  "template.translate": ["template_text"],
};
export const processingGroups = ["mail_out", "mail_in", "ai", "knowledge", "webhook"] as const;
export type ProcessingGroup = (typeof processingGroups)[number];
export const processingStates = ["active", "off", "not_set_up", "unused"] as const;
// What is missing or in the way, as a code the desk writes out.
export const processingIssues = [
  // The connection is not ready (not tested, failing or disabled).
  "not_ready",
  // A change of this entry waits for a person with the right to approve it.
  "approval_pending",
  // Outgoing mail of the project is paused.
  "paused",
  // The project has no outgoing connection, so no reply and no acknowledgement leaves.
  "no_outbound",
  // Acknowledgements are on but nothing can send them.
  "acknowledgements_without_outbound",
] as const;
export const processingEntry = z.object({
  group: z.enum(processingGroups),
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  task: z.string().nullable(),
  // The host that is reached; null when the address is not known (a default that the provider sets).
  host: z.string().nullable(),
  // A model or an account named by the entry, where that says where the data goes.
  detail: z.string().nullable(),
  receives: z.array(z.enum(contentClasses)),
  state: z.enum(processingStates),
  issues: z.array(z.enum(processingIssues)),
});
export type ProcessingEntry = z.infer<typeof processingEntry>;
export const processingOverview = z.object({
  projectId: z.uuid(),
  name: z.string(),
  entries: z.array(processingEntry),
  // Changes that wait for approval, by kind.
  pending: z.array(z.object({ kind: z.string(), target: z.string().nullable() })),
  // The number of entries that have an issue, for the list of projects.
  withIssues: z.number(),
});
export type ProcessingOverview = z.infer<typeof processingOverview>;
// The host of an address, or null.
export function hostOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}
// Where a provider of models is reached when the connection names no address of its own.
export const defaultAiHost: Record<string, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
  google: "generativelanguage.googleapis.com",
};
export const defaultGithubHost = "api.github.com";
