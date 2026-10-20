import { and, eq, inArray } from "drizzle-orm";
import { aiTasks, type AiTask } from "../domain/ai";
import { allowedProjectIds, permits, type Principal } from "../domain/permissions";
import {
  defaultAiHost,
  defaultGithubHost,
  hostOf,
  taskContent,
  type ProcessingEntry,
  type ProcessingOverview,
} from "../domain/processing";
import { retentionOf } from "../domain/retention";
import { db } from "./db";
import { aiProfiles, audit, configChanges, connections, projects, webhooks } from "./db/schema";
import { DomainError } from "./errors";
// Where the content of the tickets of a project goes (see `domain/processing.ts`): the outgoing mail connection of the
// project, the models of its tasks, its sources of knowledge and its webhooks, each with the address it reaches, what
// it receives and what is missing. It is read from the configuration and changes nothing. Whoever may read the
// configuration of a project may read it, and may take it out as a file for the records of processing; the export is an
// entry of the audit.
type Connection = typeof connections.$inferSelect;
const ready = (connection: Connection | undefined) => connection?.status === "ready";
function readable(principal: Principal, projectId: string): void {
  if (!permits(principal, projectId, "config.read")) throw new DomainError("not_found", 404);
}
async function overviewOf(projectId: string): Promise<ProcessingOverview> {
  const [project] = await db().select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new DomainError("not_found", 404);
  const [rows, profiles, hooks, pending] = await Promise.all([
    db().select().from(connections).where(eq(connections.projectId, projectId)),
    db().select().from(aiProfiles).where(eq(aiProfiles.projectId, projectId)),
    db().select().from(webhooks).where(eq(webhooks.projectId, projectId)),
    db()
      .select({ kind: configChanges.kind, target: configChanges.target })
      .from(configChanges)
      .where(and(eq(configChanges.projectId, projectId), eq(configChanges.status, "pending"))),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const waiting = (id: string, task: string | null = null) =>
    pending.some(
      (change) => change.target !== null && (change.target === id || change.target === task),
    );
  const entries: ProcessingEntry[] = [];
  const settings = project.settings;
  const outboundId =
    typeof settings.outboundConnectionId === "string" ? settings.outboundConnectionId : null;
  const outbound = outboundId ? byId.get(outboundId) : undefined;
  const acknowledgements = settings.acknowledgements === true;
  // Outgoing mail: the connection that the project sends through gets the replies and acknowledgements.
  for (const row of rows.filter((entry) => entry.direction === "outbound")) {
    const used = row.id === outboundId;
    const config = row.config;
    entries.push({
      group: "mail_out",
      id: row.id,
      name: row.name,
      kind: row.kind,
      task: null,
      host:
        row.kind === "cloudflare"
          ? "api.cloudflare.com"
          : typeof config.host === "string"
            ? config.host
            : null,
      detail:
        row.kind === "cloudflare" && typeof config.accountId === "string"
          ? `account ${config.accountId}`
          : null,
      receives: ["conversation", "subject", "customer_name", "customer_address", "template_text"],
      state: !used
        ? "unused"
        : row.status === "disabled" || settings.pauseOutgoing === true
          ? "off"
          : "active",
      issues: [
        ...(used && !ready(row) ? (["not_ready"] as const) : []),
        ...(used && settings.pauseOutgoing === true ? (["paused"] as const) : []),
        ...(waiting(row.id) ? (["approval_pending"] as const) : []),
      ],
    });
  }
  if (!outbound)
    entries.push({
      group: "mail_out",
      id: "none",
      name: "",
      kind: "none",
      task: null,
      host: null,
      detail: null,
      receives: [],
      state: "not_set_up",
      issues: [
        ...(acknowledgements
          ? (["acknowledgements_without_outbound"] as const)
          : (["no_outbound"] as const)),
      ],
    });
  // Incoming mail: where a mail is read from or stored on its way in.
  for (const row of rows.filter((entry) => entry.direction === "inbound")) {
    const config = row.config;
    entries.push({
      group: "mail_in",
      id: row.id,
      name: row.name,
      kind: row.kind,
      task: null,
      host:
        row.kind === "cloudflare"
          ? hostOf(config.endpoint)
          : typeof config.host === "string"
            ? config.host
            : null,
      detail:
        row.kind === "cloudflare" && typeof config.bucket === "string"
          ? `bucket ${config.bucket}`
          : null,
      receives: row.kind === "cloudflare" ? ["raw_mail"] : [],
      state: row.status === "disabled" ? "off" : "active",
      issues: [
        ...(!ready(row) && row.status !== "disabled" ? (["not_ready"] as const) : []),
        ...(waiting(row.id) ? (["approval_pending"] as const) : []),
      ],
    });
  }
  // Models: one entry for every task, so that a task that sends nothing is listed as such.
  for (const task of aiTasks as readonly AiTask[]) {
    const profile = profiles.find((entry) => entry.task === task);
    const connection = profile ? byId.get(profile.connectionId) : undefined;
    const config = connection?.config ?? {};
    entries.push({
      group: "ai",
      id: profile?.id ?? task,
      name: connection?.name ?? "",
      kind: connection?.kind ?? "none",
      task,
      host: connection ? (hostOf(config.endpoint) ?? defaultAiHost[connection.kind] ?? null) : null,
      detail: profile?.model ?? null,
      receives: profile ? [...taskContent[task]] : [],
      state: !profile ? "not_set_up" : profile.enabled ? "active" : "off",
      issues: [
        ...(profile?.enabled && !ready(connection) ? (["not_ready"] as const) : []),
        ...(waiting(profile?.id ?? "", task) ? (["approval_pending"] as const) : []),
      ],
    });
  }
  // Sources of knowledge: a search words go to them, and the address of the requester to a source of customer data.
  for (const row of rows.filter((entry) => entry.direction === "knowledge")) {
    const config = row.config;
    const pages = Array.isArray(config.pages) ? (config.pages as { url?: unknown }[]) : [];
    entries.push({
      group: "knowledge",
      id: row.id,
      name: row.name,
      kind: row.kind,
      task: null,
      host:
        row.kind === "github"
          ? (hostOf(config.endpoint) ?? defaultGithubHost)
          : row.kind === "docs"
            ? [...new Set(pages.map((page) => hostOf(page.url)).filter(Boolean))].join(", ") || null
            : hostOf(config.endpoint),
      detail: Array.isArray(config.repositories)
        ? (config.repositories as string[]).join(", ")
        : null,
      receives: row.kind === "context" ? ["search_words", "customer_address"] : ["search_words"],
      state: row.status === "disabled" ? "off" : "active",
      issues: [
        ...(!ready(row) && row.status !== "disabled" ? (["not_ready"] as const) : []),
        ...(waiting(row.id) ? (["approval_pending"] as const) : []),
      ],
    });
  }
  // Webhooks: events carry facts and identifiers, and the subject of a new ticket; never the content of a message.
  for (const hook of hooks)
    entries.push({
      group: "webhook",
      id: hook.id,
      name: hook.name,
      kind: "webhook",
      task: null,
      host: hostOf(hook.url),
      detail: hook.events.join(", "),
      receives: hook.events.includes("ticket.created")
        ? ["event_facts", "subject"]
        : ["event_facts"],
      state: hook.status === "active" ? "active" : "off",
      issues: waiting(hook.id) ? ["approval_pending"] : [],
    });
  const retention = retentionOf(settings);
  return {
    projectId,
    name: project.name,
    entries,
    retention,
    projectIssues: Object.values(retention).every((value) => value === null)
      ? (["no_retention"] as const)
      : [],
    pending,
    withIssues: entries.filter((entry) => entry.issues.length > 0).length,
  };
}
export async function getProcessing(principal: Principal, projectId: string) {
  readable(principal, projectId);
  return overviewOf(projectId);
}
// The overviews of every project that the caller may read the configuration of, by name.
export async function listProcessing(principal: Principal) {
  const ids = allowedProjectIds(principal, "config.read");
  if (ids.length === 0) return [];
  const known = await db()
    .select({ id: projects.id, archivedAt: projects.archivedAt })
    .from(projects)
    .where(inArray(projects.id, ids));
  const open = known.filter((row) => row.archivedAt === null).map((row) => row.id);
  const overviews = await Promise.all(open.map((id) => overviewOf(id)));
  return overviews.sort((a, b) => a.name.localeCompare(b.name));
}
// A cell that a spreadsheet would read as a formula is written as text.
const cell = (value: string): string => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export async function exportProcessing(principal: Principal, projectId: string) {
  readable(principal, projectId);
  const overview = await overviewOf(projectId);
  const header = "group,name,kind,task,host,detail,receives,state,issues";
  const lines = overview.entries.map((entry) =>
    [
      entry.group,
      entry.name,
      entry.kind,
      entry.task ?? "",
      entry.host ?? "",
      entry.detail ?? "",
      entry.receives.join(" "),
      entry.state,
      entry.issues.join(" "),
    ]
      .map(cell)
      .join(","),
  );
  await db()
    .insert(audit)
    .values({
      projectId,
      actorId: principal.id,
      action: "processing.export",
      targetId: projectId,
      detail: { entries: overview.entries.length },
    });
  return {
    filename: `processing-${new Date().toISOString().slice(0, 10)}.csv`,
    content: Buffer.from(`${[header, ...lines].join("\r\n")}\r\n`, "utf8"),
    cut: false,
  };
}
