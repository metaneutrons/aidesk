import { z } from "zod";
import { emailDesignConfig } from "../../domain/email-design";
import { actions } from "../../domain/permissions";
import { agents, ingress, messages, projects, tickets } from "../db/schema";
import { isoDate, rowSchema } from "./rows";
// What the REST API answers, as JSON. The schemas describe the response after
// serialization, so timestamps are ISO strings. Outside production the router
// checks every response against its schema.
export const errorBody = z.object({ error: z.string() });
const address = z.object({ name: z.string(), address: z.string() });
export const projectSummary = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    color: z.string(),
    defaultLanguage: z.string(),
    acknowledgements: z.boolean(),
    portalLinks: z.boolean(),
  })
  .meta({ id: "ProjectSummary" });
export const projectRow = rowSchema(projects, {
  shapes: { settings: z.record(z.string(), z.unknown()) },
});
export const ticketRow = rowSchema(tickets, { shapes: { tags: z.array(z.string()) } }).meta({
  id: "Ticket",
});
const sentSummary = z
  .object({
    at: z.string(),
    transport: z.string(),
    to: z.string(),
    from: z.string(),
    replyTo: z.string(),
    subject: z.string(),
    language: z.string(),
    templateVersion: z.number(),
    designVersion: z.number().optional(),
    portalLink: z.boolean(),
  })
  .nullable();
const attachmentSummary = z.object({
  id: z.uuid(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  inline: z.boolean(),
  refusal: z.string().nullable(),
});
export const messageOut = rowSchema(messages, {
  omit: ["rawObjectKey"],
  shapes: { source: z.record(z.string(), z.unknown()) },
})
  .extend({
    sent: sentSummary,
    html: z.string(),
    hasOriginal: z.boolean(),
    extractionUncertain: z.boolean(),
    deliveryError: z.string().nullable(),
    attachments: z.array(attachmentSummary),
  })
  .meta({ id: "Message" });
export const ticketDetail = z.object({
  ticket: ticketRow,
  messages: z.array(messageOut),
  actions: z.array(z.enum(actions)),
  sender: address.nullable(),
  recipients: z.array(address),
});
export const searchHit = z.object({
  id: z.uuid(),
  number: z.number().nullable(),
  projectId: z.uuid(),
  subject: z.string(),
  status: z.enum(["open", "waiting", "resolved"]),
  requesterName: z.string(),
  requesterEmail: z.string(),
  pendingSince: isoDate.nullable(),
  updatedAt: isoDate,
  snippet: z.string().nullable(),
});
export const tagCount = z.object({ tag: z.string(), count: z.number() });
export const overview = z.object({
  projects: z.array(
    z.object({
      projectId: z.uuid(),
      total: z.number(),
      overdue: z.number(),
      unassigned: z.number(),
      remindersDue: z.number(),
      waiting: z.number(),
    }),
  ),
  oldest: z.array(ticketRow),
});
export const originalPreview = z.object({
  subject: z.string(),
  from: z.string(),
  date: isoDate.nullable(),
  html: z.string(),
  text: z.string(),
  remoteImagesBlocked: z.number(),
  attachments: z.number(),
});
export const junkEntry = z.object({
  kind: z.enum(["ticket", "mail"]),
  id: z.uuid(),
  projectId: z.uuid(),
  subject: z.string(),
  from: z.string(),
  at: z.string(),
  reason: z.string(),
  canRestore: z.boolean(),
  mailbox: z.string().nullable(),
});
export const junkMail = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  subject: z.string(),
  from: z.string(),
  receivedAt: isoDate,
  reason: z.string(),
  attachments: z.number(),
  html: z.string(),
});
export const operatorOut = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  active: z.boolean(),
  owner: z.boolean(),
  signIn: z.array(z.enum(["password", "sso"])),
  grants: z.array(z.object({ projectId: z.uuid(), actions: z.array(z.string()) })),
});
export const agentOut = rowSchema(agents, { shapes: { actions: z.array(z.string()) } }).pick({
  id: true,
  name: true,
  actions: true,
  active: true,
  expiresAt: true,
  createdAt: true,
});
export const designOut = z.object({
  version: z.number(),
  active: z.boolean(),
  config: emailDesignConfig,
  createdBy: z.string(),
  createdAt: isoDate,
});
export const emailPreview = z.object({ version: z.number(), html: z.string(), text: z.string() });
export const testMailStatus = z.object({
  id: z.uuid(),
  status: z.string(),
  code: z.string().nullable(),
});
export const ingressRow = rowSchema(ingress);
export const versionOnly = z.object({ version: z.number() });
export const idOnly = z.object({ id: z.uuid() });
export const issuedToken = z.object({
  id: z.uuid(),
  token: z.string(),
  actions: z.array(z.string()),
  expiresAt: isoDate,
});
export const portalLinkOut = z.object({ url: z.string(), expiresAt: isoDate });
export const replyResult = z.object({ id: z.uuid(), duplicate: z.boolean() });
export const settingsOut = z
  .object({ acknowledgements: z.boolean(), portalLinks: z.boolean() })
  .partial();
