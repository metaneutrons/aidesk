import { createHash } from "node:crypto";
import { strToU8, zipSync, type Zippable } from "fflate";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { requesterExportFormat, requesterExportInput } from "../domain/requester-export";
import type { Principal } from "../domain/permissions";
import { permits } from "../domain/permissions";
import { db } from "./db";
import {
  attachments,
  attachmentTexts,
  audit,
  ingress,
  issueDrafts,
  messages,
  participants,
  projects,
  ticketIssues,
  tickets,
  translations,
} from "./db/schema";
import { DomainError } from "./errors";
import { exportCeilingBytes, lines, sha256 } from "./project-export";
import { getObject } from "./storage";
import { z } from "zod";
// What the system holds about one requester of a project, as one zip file for a request for information: the rows
// as lines of JSON, the files that they name (the original mails and the attached files), and a manifest with the
// size and the SHA-256 of each file. It holds the tickets of the address with all their messages (the notes of the
// team included, because they are about the person), their translations, links to issues, portal records, and the
// entries of the audit that name these tickets or messages, and the mail of the address that no ticket holds. It is
// made in memory with the same ceiling as the export of a project and is handed to the caller; nothing of it is
// stored, so that the file cannot outlive an erasure. The export is an entry of the audit with counts and the digest
// of the address, never the address. It needs `data.export` in the project, which no preset holds.
const id = z.uuid();
export async function exportRequester(
  principal: Principal,
  projectId: string,
  input: unknown,
  ceiling: number = exportCeilingBytes,
) {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  const project = id.parse(projectId);
  if (!permits(principal, project, "data.export")) throw new DomainError("not_found", 404);
  const { email } = requesterExportInput.parse(input);
  const [row] = await db().select().from(projects).where(eq(projects.id, project));
  if (!row) throw new DomainError("not_found", 404);
  const ticketRows = await db()
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, project), sql`lower(${tickets.requesterEmail}) = ${email}`))
    .orderBy(asc(tickets.number));
  const ticketIds = ticketRows.map((ticket) => ticket.id);
  const messageRows = ticketIds.length
    ? await db()
        .select()
        .from(messages)
        .where(inArray(messages.ticketId, ticketIds))
        .orderBy(asc(messages.createdAt))
    : [];
  const messageIds = messageRows.map((message) => message.id);
  const [participantRows, attachmentRows, translationRows, issueRows, draftRows, ingressRows] =
    await Promise.all([
      db()
        .select()
        .from(participants)
        .where(
          or(
            ticketIds.length ? inArray(participants.ticketId, ticketIds) : undefined,
            sql`lower(${participants.email}) = ${email}`,
          ),
        ),
      messageIds.length
        ? db().select().from(attachments).where(inArray(attachments.messageId, messageIds))
        : [],
      messageIds.length
        ? db().select().from(translations).where(inArray(translations.messageId, messageIds))
        : [],
      ticketIds.length
        ? db().select().from(ticketIssues).where(inArray(ticketIssues.ticketId, ticketIds))
        : [],
      ticketIds.length
        ? db().select().from(issueDrafts).where(inArray(issueDrafts.ticketId, ticketIds))
        : [],
      db()
        .select()
        .from(ingress)
        .where(
          and(
            eq(ingress.projectId, project),
            or(
              ticketIds.length ? inArray(ingress.ticketId, ticketIds) : undefined,
              sql`lower(${ingress.parsed}->>'from') = ${email}`,
            ),
          ),
        ),
    ]);
  const attachmentIds = attachmentRows.map((file) => file.id);
  const textRows = attachmentIds.length
    ? await db()
        .select()
        .from(attachmentTexts)
        .where(inArray(attachmentTexts.attachmentId, attachmentIds))
    : [];
  const named = [...ticketIds, ...messageIds];
  const auditRows = named.length
    ? await db()
        .select()
        .from(audit)
        .where(and(eq(audit.projectId, project), inArray(audit.targetId, named)))
        .orderBy(asc(audit.createdAt))
    : [];
  const keys = [
    ...new Set(
      [
        ...messageRows.map((message) => message.rawObjectKey),
        ...attachmentRows.map((file) => file.objectKey),
        ...ingressRows.map((entry) => entry.rawObjectKey),
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
  add("tickets.ndjson", lines(ticketRows));
  add("messages.ndjson", lines(messageRows));
  add("participants.ndjson", lines(participantRows));
  add("attachments.ndjson", lines(attachmentRows));
  add("attachment-texts.ndjson", lines(textRows));
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
      missing.push(key);
      continue;
    }
    add(`objects/${key}`, new Uint8Array(body), 0);
  }
  const counts = {
    tickets: ticketRows.length,
    messages: messageRows.length,
    attachments: attachmentRows.length,
    translations: translationRows.length,
    portalRecords: participantRows.length,
    ingress: ingressRows.length,
    audit: auditRows.length,
    objects: keys.length - missing.length,
    missingObjects: missing.length,
  };
  files["manifest.json"] = strToU8(
    JSON.stringify(
      {
        format: requesterExportFormat,
        project: { id: row.id, name: row.name },
        requester: email,
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
  await db()
    .insert(audit)
    .values({
      projectId: project,
      actorId: principal.id,
      action: "requester.export",
      targetId: project,
      detail: {
        requester: createHash("sha256").update(email).digest("hex"),
        digest,
        bytes: zip.length,
        counts,
      },
    });
  return {
    filename: `requester-${createHash("sha256").update(email).digest("hex").slice(0, 12)}-${new Date().toISOString().slice(0, 10)}.zip`,
    content: Buffer.from(zip),
    digest,
    counts,
  };
}
