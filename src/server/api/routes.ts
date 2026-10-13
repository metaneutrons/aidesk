import { z } from "zod";
import type { Action } from "../../domain/permissions";
import type { Principal } from "../../domain/permissions";
import { emailDesignConfig } from "../../domain/email-design";
import {
  activeInput,
  createOperator,
  createProject,
  createProjectInput,
  getAttachment,
  getJunkMail,
  getOriginal,
  getOriginalPreview,
  getOverview,
  getTicket,
  grantInput,
  issueAgentToken,
  issueInput,
  listAgentTokens,
  listJunk,
  listOperators,
  listProjects,
  listTags,
  listTickets,
  localeInput,
  moveTicketToJunk,
  operatorInput,
  projectSettingsInput,
  reminderInput,
  reply,
  replyInput,
  restoreJunkMail,
  restoreTicket,
  revokeAgentToken,
  searchTickets,
  setLocale,
  setOperatorActive,
  setOperatorGrant,
  setProjectSettings,
  setReminder,
  setTicketTags,
  tagsInput,
} from "../operations";
import {
  createEmailDesign,
  getTestMail,
  listEmailDesigns,
  previewEmail,
  previewInput,
  selectEmailDesign,
  selectInput,
  sendTestMail,
  testMailInput,
} from "../email-design";
import { issuePortalGrant, portalLinkInput, portalUrl, revokePortalGrant } from "../portal";
import * as out from "./schemas";
import { isoDate } from "./rows";
// Every REST route, once: method, path, who may call it, what it takes and what
// it answers. The router, the published API definition and (later) the MCP tools
// are derived from this table, so none of them can drift from the others.
//
// Bodies are validated by the domain operations with the same schema objects
// that are listed here; the router does not validate a second time.
export interface RouteContext {
  principal: Principal;
  params: Record<string, string>;
  query: URLSearchParams;
  input: unknown;
  request: Request;
}
// The action that has to be granted for the project concerned. "owner" and
// "human" are checks on the person: the instance owner, or any signed-in
// operator (agent tokens are refused).
export type Access = Action | "owner" | "human" | "any";
interface Base {
  id: string;
  method: "GET" | "POST";
  path: string;
  tag: string;
  summary: string;
  access: Access;
  query?: z.ZodObject;
}
export interface JsonRoute extends Base {
  binary?: false;
  body?: z.ZodType;
  response: z.ZodType;
  status?: number;
  headers?: Record<string, string>;
  run: (context: RouteContext) => Promise<unknown>;
}
export interface BinaryRoute extends Base {
  binary: true;
  run: (context: RouteContext) => Promise<Response>;
}
export type Route = JsonRoute | BinaryRoute;
const projects = z.array(z.uuid()).optional().describe("Limit to these projects");
const projectQuery = z.object({ project: projects });
const list = (schema: z.ZodType) => z.array(schema);
function download(file: { filename: string; content: Buffer }): Response {
  const ascii = file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(new Uint8Array(file.content), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.content.length),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}
export const routes: Route[] = [
  {
    id: "projects.list",
    method: "GET",
    path: "/projects",
    tag: "Projects",
    summary: "List the projects the caller may read",
    access: "project.read",
    response: list(out.projectSummary),
    run: ({ principal }) => listProjects(principal),
  },
  {
    id: "operators.list",
    method: "GET",
    path: "/operators",
    tag: "Operators",
    summary: "List operators with their sign-in methods and the grants the caller manages",
    access: "project.manage",
    response: list(out.operatorOut),
    run: ({ principal }) => listOperators(principal),
  },
  {
    id: "agents.list",
    method: "GET",
    path: "/projects/{projectId}/agents",
    tag: "Agents",
    summary: "List the agent tokens of a project (never the token itself)",
    access: "agent.manage",
    response: list(out.agentOut),
    run: ({ principal, params }) => listAgentTokens(principal, params.projectId ?? ""),
  },
  {
    id: "designs.list",
    method: "GET",
    path: "/projects/{projectId}/designs",
    tag: "Email designs",
    summary: "List the saved versions of the mail design and which one is active",
    access: "project.read",
    response: list(out.designOut),
    run: ({ principal, params }) => listEmailDesigns(principal, params.projectId ?? ""),
  },
  {
    id: "testMails.get",
    method: "GET",
    path: "/test-mails/{jobId}",
    tag: "Email designs",
    summary: "How a test mail went; visible to the person who asked for it",
    access: "project.manage",
    response: out.testMailStatus,
    run: ({ principal, params }) => getTestMail(principal, params.jobId ?? ""),
  },
  {
    id: "tags.list",
    method: "GET",
    path: "/tags",
    tag: "Tickets",
    summary: "Tags in use in the authorized projects with their counts",
    access: "ticket.read",
    query: projectQuery,
    response: list(out.tagCount),
    run: ({ principal, query }) => listTags(principal, query.getAll("project")),
  },
  {
    id: "tickets.search",
    method: "GET",
    path: "/tickets/search",
    tag: "Tickets",
    summary: "Search subject, requester, tags and every message of the authorized tickets",
    access: "ticket.read",
    query: z.object({
      q: z.string().min(2).max(100).describe("Text to search for"),
      project: projects,
    }),
    response: list(out.searchHit),
    run: ({ principal, query }) =>
      searchTickets(principal, query.get("q"), query.getAll("project")),
  },
  {
    id: "tickets.get",
    method: "GET",
    path: "/tickets/{ticketId}",
    tag: "Tickets",
    summary: "A ticket with its conversation and the actions the caller holds",
    access: "ticket.read",
    response: out.ticketDetail,
    run: ({ principal, params }) => getTicket(principal, params.ticketId ?? ""),
  },
  {
    id: "originals.download",
    method: "GET",
    path: "/messages/{messageId}/original",
    tag: "Tickets",
    summary: "Download the received mail (.eml)",
    access: "ticket.read",
    binary: true,
    run: async ({ principal, params }) =>
      download(await getOriginal(principal, params.messageId ?? "")),
  },
  {
    id: "originals.preview",
    method: "GET",
    path: "/messages/{messageId}/original/preview",
    tag: "Tickets",
    summary: "The received mail as a safe view",
    access: "ticket.read",
    response: out.originalPreview,
    run: ({ principal, params }) => getOriginalPreview(principal, params.messageId ?? ""),
  },
  {
    id: "junk.list",
    method: "GET",
    path: "/junk",
    tag: "Junk",
    summary: "Tickets and mail in junk",
    access: "ticket.read",
    query: projectQuery,
    response: list(out.junkEntry),
    run: ({ principal, query }) => listJunk(principal, query.getAll("project")),
  },
  {
    id: "junk.get",
    method: "GET",
    path: "/junk/{ingressId}",
    tag: "Junk",
    summary: "A junk mail with a sanitized preview",
    access: "ticket.read",
    response: out.junkMail,
    run: ({ principal, params }) => getJunkMail(principal, params.ingressId ?? ""),
  },
  {
    id: "attachments.download",
    method: "GET",
    path: "/attachments/{attachmentId}",
    tag: "Tickets",
    summary: "Download an attachment",
    access: "ticket.read",
    binary: true,
    run: async ({ principal, params }) =>
      download(await getAttachment(principal, params.attachmentId ?? "")),
  },
  {
    id: "tickets.list",
    method: "GET",
    path: "/tickets",
    tag: "Tickets",
    summary: "List tickets, oldest unanswered first, in steps of 250 up to 2000",
    access: "ticket.read",
    query: z.object({
      project: projects,
      limit: z.number().int().min(1).max(2000).optional().describe("How many to load"),
    }),
    response: list(out.ticketRow),
    run: ({ principal, query }) =>
      listTickets(
        principal,
        query.getAll("project"),
        query.has("limit") ? Number(query.get("limit")) : undefined,
      ),
  },
  {
    id: "overview.get",
    method: "GET",
    path: "/overview",
    tag: "Tickets",
    summary: "Counts per project over all tickets and the oldest unanswered ones",
    access: "ticket.read",
    query: projectQuery,
    response: out.overview,
    run: ({ principal, query }) => getOverview(principal, query.getAll("project")),
  },
  {
    id: "projects.create",
    method: "POST",
    path: "/projects",
    tag: "Projects",
    summary: "Create a project",
    access: "owner",
    body: createProjectInput,
    response: out.projectRow,
    status: 201,
    run: ({ principal, input }) => createProject(principal, input),
  },
  {
    id: "operators.create",
    method: "POST",
    path: "/operators",
    tag: "Operators",
    summary: "Create an operator",
    access: "owner",
    body: operatorInput,
    response: z.object({ id: z.string(), name: z.string(), email: z.string() }),
    status: 201,
    run: ({ principal, input }) => createOperator(principal, input),
  },
  {
    id: "operators.grant",
    method: "POST",
    path: "/operators/{operatorId}/grants",
    tag: "Operators",
    summary: "Set the actions an operator holds in a project",
    access: "project.manage",
    body: grantInput,
    response: z.object({
      userId: z.string(),
      projectId: z.uuid(),
      actions: z.array(z.string()),
    }),
    run: ({ principal, params, input }) =>
      setOperatorGrant(principal, params.operatorId ?? "", input),
  },
  {
    id: "operators.setActive",
    method: "POST",
    path: "/operators/{operatorId}/active",
    tag: "Operators",
    summary: "Activate or deactivate an operator",
    access: "owner",
    body: activeInput,
    response: z.object({ id: z.string(), active: z.boolean() }),
    run: ({ principal, params, input }) =>
      setOperatorActive(principal, params.operatorId ?? "", input),
  },
  {
    id: "agents.issue",
    method: "POST",
    path: "/projects/{projectId}/agents",
    tag: "Agents",
    summary: "Issue an agent token; it is shown once",
    access: "agent.manage",
    body: issueInput,
    response: out.issuedToken,
    status: 201,
    run: ({ principal, params, input }) =>
      issueAgentToken(principal, params.projectId ?? "", input),
  },
  {
    id: "projects.settings",
    method: "POST",
    path: "/projects/{projectId}/settings",
    tag: "Projects",
    summary: "Change project behaviour (acknowledgements, portal links)",
    access: "project.manage",
    body: projectSettingsInput,
    response: out.settingsOut,
    run: ({ principal, params, input }) =>
      setProjectSettings(principal, params.projectId ?? "", input),
  },
  {
    id: "designs.create",
    method: "POST",
    path: "/projects/{projectId}/designs",
    tag: "Email designs",
    summary: "Save a new version of the mail design",
    access: "project.manage",
    body: emailDesignConfig,
    response: out.versionOnly,
    status: 201,
    run: ({ principal, params, input }) =>
      createEmailDesign(principal, params.projectId ?? "", input),
  },
  {
    id: "designs.select",
    method: "POST",
    path: "/projects/{projectId}/designs/select",
    tag: "Email designs",
    summary: "Select the design for mail sent from now on (0 is the built-in design)",
    access: "project.manage",
    body: selectInput,
    response: out.versionOnly,
    run: ({ principal, params, input }) =>
      selectEmailDesign(
        principal,
        params.projectId ?? "",
        (input as { version?: unknown }).version,
      ),
  },
  {
    id: "designs.preview",
    method: "POST",
    path: "/projects/{projectId}/designs/preview",
    tag: "Email designs",
    summary: "Render a sample mail with a saved version or a draft configuration",
    access: "project.read",
    body: previewInput,
    response: out.emailPreview,
    run: ({ principal, params, input }) => previewEmail(principal, params.projectId ?? "", input),
  },
  {
    id: "designs.test",
    method: "POST",
    path: "/projects/{projectId}/designs/test",
    tag: "Email designs",
    summary: "Send a test mail of a design to the caller",
    access: "project.manage",
    body: testMailInput,
    response: out.idOnly,
    status: 202,
    run: ({ principal, params, input }) => sendTestMail(principal, params.projectId ?? "", input),
  },
  {
    id: "agents.revoke",
    method: "POST",
    path: "/agents/{agentId}/revoke",
    tag: "Agents",
    summary: "Revoke an agent token",
    access: "agent.manage",
    response: z.object({ revoked: z.boolean() }),
    run: ({ principal, params }) => revokeAgentToken(principal, params.agentId ?? ""),
  },
  {
    id: "portalLinks.issue",
    method: "POST",
    path: "/tickets/{ticketId}/portal-link",
    tag: "Customer portal",
    summary: "Issue the portal link of the ticket's requester; it is shown once",
    access: "ticket.reply",
    body: portalLinkInput,
    response: out.portalLinkOut,
    status: 201,
    headers: { "Cache-Control": "no-store" },
    run: async ({ principal, params, input }) => {
      const grant = await issuePortalGrant(principal, params.ticketId ?? "", input);
      return { url: portalUrl(grant.token), expiresAt: grant.expiresAt };
    },
  },
  {
    id: "portalLinks.revoke",
    method: "POST",
    path: "/tickets/{ticketId}/portal-link/revoke",
    tag: "Customer portal",
    summary: "Disable the portal link of the ticket's requester",
    access: "ticket.reply",
    response: z.object({ revoked: z.boolean() }),
    run: ({ principal, params }) => revokePortalGrant(principal, params.ticketId ?? ""),
  },
  {
    id: "tickets.tags",
    method: "POST",
    path: "/tickets/{ticketId}/tags",
    tag: "Tickets",
    summary: "Replace the tags of a ticket",
    access: "ticket.note",
    body: tagsInput,
    response: z.object({ tags: z.array(z.string()) }),
    run: ({ principal, params, input }) => setTicketTags(principal, params.ticketId ?? "", input),
  },
  {
    id: "tickets.reminder",
    method: "POST",
    path: "/tickets/{ticketId}/reminder",
    tag: "Tickets",
    summary: "Set or clear the reminder of a ticket",
    access: "ticket.note",
    body: reminderInput,
    response: z.object({ remindAt: isoDate.nullable() }),
    run: ({ principal, params, input }) => setReminder(principal, params.ticketId ?? "", input),
  },
  {
    id: "tickets.junk",
    method: "POST",
    path: "/tickets/{ticketId}/junk",
    tag: "Junk",
    summary: "Move a ticket to junk",
    access: "ticket.junk",
    response: z.object({ junk: z.boolean() }),
    run: ({ principal, params }) => moveTicketToJunk(principal, params.ticketId ?? ""),
  },
  {
    id: "tickets.restore",
    method: "POST",
    path: "/tickets/{ticketId}/restore",
    tag: "Junk",
    summary: "Restore a ticket from junk",
    access: "ticket.junk",
    response: z.object({ junk: z.boolean() }),
    run: ({ principal, params }) => restoreTicket(principal, params.ticketId ?? ""),
  },
  {
    id: "junk.restore",
    method: "POST",
    path: "/junk/{ingressId}/restore",
    tag: "Junk",
    summary: "Hand a junk mail back to inbound processing",
    access: "ticket.junk",
    response: z.object({ restored: z.boolean() }),
    run: ({ principal, params }) => restoreJunkMail(principal, params.ingressId ?? ""),
  },
  {
    id: "tickets.reply",
    method: "POST",
    path: "/tickets/{ticketId}/reply",
    tag: "Tickets",
    summary: "Queue a reply or record an internal note",
    access: "ticket.reply",
    body: replyInput,
    response: out.replyResult,
    status: 202,
    run: ({ principal, params, input }) => reply(principal, params.ticketId ?? "", input),
  },
  {
    id: "me.locale",
    method: "POST",
    path: "/me/locale",
    tag: "Operators",
    summary: "Set the interface language of the signed-in operator",
    access: "human",
    body: localeInput,
    response: z.object({ updated: z.boolean() }),
    run: async ({ principal, input }) => {
      await setLocale(principal, input);
      return { updated: true };
    },
  },
];
