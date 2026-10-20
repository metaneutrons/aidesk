import { createHash, randomUUID } from "node:crypto";
import { strToU8, zipSync, type Zippable } from "fflate";
import { asc, desc, eq, getTableColumns, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Principal } from "../domain/permissions";
import { managesProject } from "./archive";
import { db } from "./db";
import {
  agents,
  attachments,
  attachmentTexts,
  audit,
  configChanges,
  connections,
  emailDesigns,
  ingress,
  issueDrafts,
  memberships,
  messages,
  operatorGroupMembers,
  operatorGroups,
  participants,
  cannedReplies,
  portalBranding,
  projectTags,
  routingRules,
  senderRules,
  portalDomains,
  projectExports,
  projects,
  projectTexts,
  aiProfiles,
  ticketIssues,
  tickets,
  translations,
  user,
  webhooks,
} from "./db/schema";
import { DomainError } from "./errors";
import { getObject, putObject } from "./storage";
// The export of a project: one zip file that holds its rows as lines of JSON (`*.ndjson`, one file for each kind
// of row), its settings (`project.json`), every object that its rows name (`objects/<key>`) and a manifest with
// the size and the SHA-256 of each file. It is made in one piece in memory, so it has a ceiling; a project that is
// larger than that is taken with the backup of the installation instead. Secrets are never in it: not the secret of
// a connection or a webhook, not the hash of a token of an agent, and not the payload of a change of the
// configuration, which holds sealed secrets.
const id = z.uuid();
export const exportCeilingBytes = 200 * 1024 * 1024;
function without<T extends PgTable>(table: T, ...omit: string[]) {
  const columns = Object.entries(getTableColumns(table)).filter(([name]) => !omit.includes(name));
  return Object.fromEntries(columns) as ReturnType<typeof getTableColumns<T>>;
}
export const lines = (rows: unknown[]) =>
  strToU8(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
async function mayExport(principal: Principal, projectId: string): Promise<string> {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  const project = id.parse(projectId);
  if (!(await managesProject(principal, project))) throw new DomainError("not_found", 404);
  return project;
}
export const exportKey = (project: string, exportId: string) =>
  `exports/${project}/${exportId}.zip`;
export async function createProjectExport(
  principal: Principal,
  projectId: string,
  ceiling: number = exportCeilingBytes,
) {
  const project = await mayExport(principal, projectId);
  const [row] = await db().select().from(projects).where(eq(projects.id, project));
  if (!row) throw new DomainError("not_found", 404);
  const ticketIds = db()
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.projectId, project));
  const messageIds = db()
    .select({ id: messages.id })
    .from(messages)
    .where(inArray(messages.ticketId, ticketIds));
  const [
    ticketRows,
    messageRows,
    participantRows,
    attachmentRows,
    attachmentTextRows,
    translationRows,
    issueRows,
    draftRows,
    ingressRows,
    connectionRows,
    webhookRows,
    textRows,
    designRows,
    profileRows,
    memberRows,
    agentRows,
    domainRows,
    changeRows,
    auditRows,
    groupRows,
    groupMemberRows,
    brandingRows,
    senderRuleRows,
    routingRuleRows,
    cannedRows,
    tagRows,
  ] = await Promise.all([
    db().select().from(tickets).where(eq(tickets.projectId, project)).orderBy(asc(tickets.number)),
    db()
      .select()
      .from(messages)
      .where(inArray(messages.ticketId, ticketIds))
      .orderBy(asc(messages.createdAt)),
    db().select().from(participants).where(inArray(participants.ticketId, ticketIds)),
    db().select().from(attachments).where(eq(attachments.projectId, project)),
    db().select().from(attachmentTexts).where(eq(attachmentTexts.projectId, project)),
    db().select().from(translations).where(inArray(translations.messageId, messageIds)),
    db().select().from(ticketIssues).where(eq(ticketIssues.projectId, project)),
    db().select().from(issueDrafts).where(eq(issueDrafts.projectId, project)),
    db().select().from(ingress).where(eq(ingress.projectId, project)),
    db()
      .select(without(connections, "secretCiphertext"))
      .from(connections)
      .where(eq(connections.projectId, project)),
    db()
      .select(without(webhooks, "secretCiphertext"))
      .from(webhooks)
      .where(eq(webhooks.projectId, project)),
    db().select().from(projectTexts).where(eq(projectTexts.projectId, project)),
    db().select().from(emailDesigns).where(eq(emailDesigns.projectId, project)),
    db().select().from(aiProfiles).where(eq(aiProfiles.projectId, project)),
    db()
      .select({
        userId: memberships.userId,
        actions: memberships.actions,
        email: user.email,
        name: user.name,
      })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(eq(memberships.projectId, project)),
    db().select(without(agents, "tokenHash")).from(agents).where(eq(agents.projectId, project)),
    db().select().from(portalDomains).where(eq(portalDomains.projectId, project)),
    db()
      .select(without(configChanges, "payload", "idempotencyKey"))
      .from(configChanges)
      .where(eq(configChanges.projectId, project))
      .orderBy(asc(configChanges.createdAt)),
    db().select().from(audit).where(eq(audit.projectId, project)).orderBy(asc(audit.createdAt)),
    db().select().from(operatorGroups).where(eq(operatorGroups.projectId, project)),
    db()
      .select({
        groupId: operatorGroupMembers.groupId,
        userId: operatorGroupMembers.userId,
        email: user.email,
      })
      .from(operatorGroupMembers)
      .innerJoin(operatorGroups, eq(operatorGroups.id, operatorGroupMembers.groupId))
      .innerJoin(user, eq(user.id, operatorGroupMembers.userId))
      .where(eq(operatorGroups.projectId, project)),
    db().select().from(portalBranding).where(eq(portalBranding.projectId, project)),
    db().select().from(senderRules).where(eq(senderRules.projectId, project)),
    db().select().from(routingRules).where(eq(routingRules.projectId, project)),
    db().select().from(cannedReplies).where(eq(cannedReplies.projectId, project)),
    db().select().from(projectTags).where(eq(projectTags.projectId, project)),
  ]);
  // The objects that the rows name, once each.
  const keys = [
    ...new Set(
      [
        ...messageRows.map((message) => message.rawObjectKey),
        ...attachmentRows.map((attachment) => attachment.objectKey),
        ...ingressRows.map((entry) => entry.rawObjectKey),
        ...brandingRows.map((entry) => entry.logoKey),
      ].filter((key): key is string => typeof key === "string" && key.length > 0),
    ),
  ].sort();
  const files: Zippable = {};
  const manifest: { path: string; bytes: number; sha256: string }[] = [];
  let total = 0;
  const add = (path: string, data: Uint8Array, level: 0 | 6 = 6) => {
    total += data.length;
    if (total > ceiling) throw new DomainError("project_export_too_large", 413);
    files[path] = [data, { level }];
    manifest.push({ path, bytes: data.length, sha256: sha256(data) });
  };
  add(
    "project.json",
    strToU8(
      JSON.stringify(
        {
          project: row,
          memberships: memberRows,
          groups: groupRows.map((group) => ({
            ...group,
            members: groupMemberRows.filter((member) => member.groupId === group.id),
          })),
          agents: agentRows,
          connections: connectionRows,
          webhooks: webhookRows,
          texts: textRows,
          designs: designRows,
          aiProfiles: profileRows,
          portalDomains: domainRows,
          portalBranding: brandingRows,
          senderRules: senderRuleRows,
          routingRules: routingRuleRows,
          cannedReplies: cannedRows,
          tagColors: tagRows,
          configChanges: changeRows,
        },
        null,
        2,
      ),
    ),
  );
  add("tickets.ndjson", lines(ticketRows));
  add("messages.ndjson", lines(messageRows));
  add("participants.ndjson", lines(participantRows));
  add("attachments.ndjson", lines(attachmentRows));
  add("attachment-texts.ndjson", lines(attachmentTextRows));
  add("translations.ndjson", lines(translationRows));
  add("ticket-issues.ndjson", lines(issueRows));
  add("issue-drafts.ndjson", lines(draftRows));
  add("ingress.ndjson", lines(ingressRows));
  add("audit.ndjson", lines(auditRows));
  const missing: string[] = [];
  for (const key of keys) {
    let body: Buffer;
    try {
      body = await getObject(key);
    } catch {
      // An object that a row names and that the storage does not have is told in the manifest, not hidden.
      missing.push(key);
      continue;
    }
    add(`objects/${key}`, new Uint8Array(body), 0);
  }
  const counts: Record<string, number> = {
    tickets: ticketRows.length,
    messages: messageRows.length,
    attachments: attachmentRows.length,
    objects: keys.length - missing.length,
    missingObjects: missing.length,
    audit: auditRows.length,
  };
  files["manifest.json"] = strToU8(
    JSON.stringify(
      {
        format: "aidesk-project-export-1",
        project: { id: row.id, name: row.name, slug: row.slug },
        exportedAt: new Date().toISOString(),
        counts,
        missingObjects: missing,
        files: manifest,
      },
      null,
      2,
    ),
  );
  const zip = zipSync(files);
  const digest = sha256(zip);
  const exportId = randomUUID();
  const objectKey = exportKey(project, exportId);
  await putObject(objectKey, Buffer.from(zip), "application/zip");
  const [made] = await db().transaction(async (tx) => {
    const inserted = await tx
      .insert(projectExports)
      .values({
        id: exportId,
        projectId: project,
        projectName: row.name,
        digest,
        bytes: zip.length,
        counts,
        objectKey,
        createdBy: principal.id,
      })
      .returning();
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "project.export",
      targetId: exportId,
      detail: { digest, bytes: zip.length, counts },
    });
    return inserted;
  });
  if (!made) throw new DomainError("conflict", 409);
  return exportView(made);
}
type ExportRow = typeof projectExports.$inferSelect;
const exportView = (row: ExportRow) => ({
  id: row.id,
  projectId: row.projectId,
  projectName: row.projectName,
  digest: row.digest,
  bytes: row.bytes,
  counts: row.counts,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
});
export async function listProjectExports(principal: Principal, projectId: string) {
  const project = await mayExport(principal, projectId);
  const rows = await db()
    .select()
    .from(projectExports)
    .where(eq(projectExports.projectId, project))
    .orderBy(desc(projectExports.createdAt));
  return rows.map(exportView);
}
export async function readProjectExport(principal: Principal, projectId: string, exportId: string) {
  const project = await mayExport(principal, projectId);
  const [row] = await db()
    .select()
    .from(projectExports)
    .where(eq(projectExports.id, id.parse(exportId)));
  if (row?.projectId !== project) throw new DomainError("not_found", 404);
  const content = await getObject(row.objectKey).catch(() => null);
  if (!content) throw new DomainError("not_found", 404);
  const safe = row.projectName.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "project";
  return {
    filename: `${safe}-${row.createdAt.toISOString().slice(0, 10)}.zip`,
    content,
    digest: row.digest,
  };
}
