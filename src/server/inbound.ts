import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { simpleParser, type AddressObject } from "mailparser";
import TurndownService from "turndown";
import { db } from "./db";
import { attachments, ingress, jobs, messages, projects, tickets } from "./db/schema";
import { getObject, putObject } from "./storage";
import { extractReply } from "../domain/extraction";
import { classifyJunk } from "../domain/junk";
import { attachmentRefusal, safeFilename } from "../domain/attachments";
import {
  acknowledgementInterval,
  acknowledgementText,
  isAutomaticMail,
} from "../domain/acknowledgement";
import { isMessageId } from "../domain/threading";
// Inbound mail, independent of the adapter that received it. The original is
// stored first, then the ingress record and its processing job are committed
// together. Processing is idempotent and may be retried.
const maxRawBytes = 25 * 1024 * 1024;
const reopenWindowMs = 30 * 86_400_000;
export async function acceptInbound(input: {
  projectId: string;
  connectionId: string | null;
  // Namespaced by the adapter, for example imap:<connection>:<uidvalidity>:<uid>.
  externalKey: string;
  raw: Buffer;
}): Promise<{ ingressId: string; duplicate: boolean }> {
  if (input.raw.length === 0 || input.raw.length > maxRawBytes) throw new Error("inbound_size");
  const checksum = createHash("sha256").update(input.raw).digest("hex");
  const rawObjectKey = `inbound/${input.projectId}/${checksum}.eml`;
  await putObject(rawObjectKey, input.raw, "message/rfc822");
  return db().transaction(async (tx) => {
    const [created] = await tx
      .insert(ingress)
      .values({
        projectId: input.projectId,
        connectionId: input.connectionId,
        externalKey: input.externalKey,
        rawObjectKey,
        checksum,
      })
      .onConflictDoNothing({ target: ingress.externalKey })
      .returning({ id: ingress.id });
    if (!created) {
      const [existing] = await tx
        .select({ id: ingress.id })
        .from(ingress)
        .where(eq(ingress.externalKey, input.externalKey));
      if (!existing) throw new Error("inbound_conflict");
      return { ingressId: existing.id, duplicate: true };
    }
    await tx.insert(jobs).values({
      projectId: input.projectId,
      type: "mail.ingest",
      dedupKey: `ingest:${created.id}`,
      payload: { ingressId: created.id },
    });
    return { ingressId: created.id, duplicate: false };
  });
}
function firstAddress(value: AddressObject | AddressObject[] | undefined) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const entry = list.flatMap((item) => item.value).find((item) => item.address);
  return entry?.address
    ? { address: entry.address.toLowerCase(), name: entry.name || entry.address }
    : null;
}
function referenceIds(inReplyTo: string | undefined, references: string | string[] | undefined) {
  const all = [inReplyTo, ...(Array.isArray(references) ? references : [references])]
    .flatMap((value) => value?.split(/\s+/) ?? [])
    .filter((value) => isMessageId(value));
  return [...new Set(all)];
}
const turndown = new TurndownService({ codeBlockStyle: "fenced", headingStyle: "atx" });
// Signature blocks marked by Gmail and Outlook get the standard "-- "
// delimiter, so the extraction treats them like a plain-text signature.
turndown.addRule("signature", {
  filter: (node) =>
    node.nodeName === "DIV" &&
    (/\bgmail_signature\b/.test(node.getAttribute("class") ?? "") ||
      node.getAttribute("id") === "Signature"),
  replacement: (content) => `\n\n-- \n${content}\n`,
});
// HTML keeps lists, links and code better than the derived text part;
// quoted history becomes "> " lines that the extraction recognises.
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}
export type IngestOutcome =
  "created" | "appended" | "reopened" | "duplicate" | "follow_up" | "junk";
export async function processIngress(ingressId: string): Promise<IngestOutcome | "done"> {
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  if (!entry) throw new Error("ingress_missing");
  if (entry.state !== "queued") return "done";
  const mail = await simpleParser(await getObject(entry.rawObjectKey));
  const sender = firstAddress(mail.from);
  if (!sender) {
    await db().update(ingress).set({ state: "review" }).where(eq(ingress.id, entry.id));
    throw new Error("inbound_sender_missing");
  }
  const messageId = isMessageId(mail.messageId) ? mail.messageId : null;
  const body =
    typeof mail.html === "string" && mail.html.trim()
      ? htmlToMarkdown(mail.html)
      : (mail.text ?? "");
  const extraction = extractReply(body.trim() ? body : "(no text content)");
  const references = referenceIds(mail.inReplyTo, mail.references);
  const subject = (mail.subject ?? "").trim() || "(no subject)";
  const receivedAt = entry.receivedAt;
  // Files are stored before the transaction, like the original, under their
  // checksum; storing the same file again is harmless. Refused files are not
  // stored at all.
  const files = mail.attachments.map((file, index) => {
    const filename = safeFilename(file.filename, index);
    const contentType = (file.contentType || "application/octet-stream").toLowerCase();
    return {
      filename,
      contentType,
      size: file.content.length,
      checksum: createHash("sha256").update(file.content).digest("hex"),
      inline: file.contentDisposition === "inline",
      contentId: file.cid ? file.cid.slice(0, 200) : null,
      refusal: attachmentRefusal({ filename, contentType, size: file.content.length }, index),
      content: file.content,
    };
  });
  for (const file of files)
    if (!file.refusal)
      await putObject(
        `attachments/${entry.projectId}/${file.checksum}`,
        file.content,
        "application/octet-stream",
      );
  return db().transaction(async (tx) => {
    // Serialise processing per project so duplicates and threading decisions
    // see each other's results.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ingest:${entry.projectId}`}))`);
    const [current] = await tx
      .select({ state: ingress.state })
      .from(ingress)
      .where(eq(ingress.id, entry.id))
      .for("update");
    if (current?.state !== "queued") return "done";
    const finish = async (ticketId: string | null, state: string, outcome: IngestOutcome) => {
      await tx
        .update(ingress)
        .set({
          state,
          ticketId,
          parsed: { messageId, from: sender.address, subject, references, outcome },
        })
        .where(eq(ingress.id, entry.id));
      return outcome;
    };
    if (messageId) {
      const [seen] = await tx
        .select({ ticketId: messages.ticketId })
        .from(messages)
        .innerJoin(tickets, eq(tickets.id, messages.ticketId))
        .where(
          and(eq(tickets.projectId, entry.projectId), eq(messages.receivedMessageId, messageId)),
        )
        .limit(1);
      if (seen) return finish(seen.ticketId, "duplicate", "duplicate");
    }
    // Junk stays out of the inbox: no ticket, nothing added to an existing
    // ticket, no acknowledgement. A restored mail is not classified again.
    const verdict = entry.classification?.restored ? null : classifyJunk(mail.headers);
    if (verdict?.junk) {
      await tx
        .update(ingress)
        .set({
          classification: {
            ...entry.classification,
            verdict: "junk",
            reason: verdict.reason,
            source: "rules",
            at: new Date().toISOString(),
          },
        })
        .where(eq(ingress.id, entry.id));
      return finish(null, "junk", "junk");
    }
    // A reply continues a ticket only through a reference to one of its
    // messages in this project and only from the ticket's requester. Claimed
    // identifiers alone, or another sender, start a separate ticket.
    let target: typeof tickets.$inferSelect | undefined;
    if (references.length) {
      const [match] = await tx
        .select({ ticket: tickets })
        .from(messages)
        .innerJoin(tickets, eq(tickets.id, messages.ticketId))
        .where(
          and(
            eq(tickets.projectId, entry.projectId),
            or(
              inArray(messages.receivedMessageId, references),
              inArray(sql<string>`${messages.source}->>'messageId'`, references),
            ),
          ),
        )
        .orderBy(sql`${messages.createdAt} desc`)
        .limit(1);
      if (match?.ticket.requesterEmail.toLowerCase() === sender.address) target = match.ticket;
    }
    const source = {
      from: sender.address,
      subject,
      extraction: "parser",
      trimmed: extraction.trimmed,
      uncertain: extraction.uncertain,
      attachments: mail.attachments.length,
    };
    const insertMessage = async (ticketId: string, language: string, followUpOf?: string) => {
      const [message] = await tx
        .insert(messages)
        .values({
          ticketId,
          authorType: "customer",
          authorName: sender.name,
          authorEmail: sender.address,
          markdown: extraction.markdown,
          language,
          receivedMessageId: messageId,
          rawObjectKey: entry.rawObjectKey,
          deliveryState: "received",
          source: followUpOf ? { ...source, followUpOf } : source,
          createdAt: receivedAt,
        })
        .returning({ id: messages.id });
      if (!message) throw new Error("message_creation_failed");
      if (files.length)
        await tx.insert(attachments).values(
          files.map((file, position) => ({
            messageId: message.id,
            position,
            projectId: entry.projectId,
            filename: file.filename,
            contentType: file.contentType,
            size: file.size,
            checksum: file.checksum,
            objectKey: file.refusal ? null : `attachments/${entry.projectId}/${file.checksum}`,
            inline: file.inline,
            contentId: file.contentId,
            refusal: file.refusal,
          })),
        );
    };
    const recentlyResolved =
      target?.status === "resolved" &&
      target.resolvedAt !== null &&
      receivedAt.getTime() - target.resolvedAt.getTime() <= reopenWindowMs;
    if (target && (target.status !== "resolved" || recentlyResolved)) {
      await insertMessage(target.id, target.language);
      await tx
        .update(tickets)
        .set({
          status: "open",
          resolvedAt: null,
          // The obligation starts at the first still-unanswered message.
          pendingSince: target.pendingSince ?? receivedAt,
          revision: sql`${tickets.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(tickets.id, target.id));
      return finish(target.id, "processed", recentlyResolved ? "reopened" : "appended");
    }
    const [project] = await tx
      .select({
        name: projects.name,
        defaultLanguage: projects.defaultLanguage,
        settings: projects.settings,
      })
      .from(projects)
      .where(eq(projects.id, entry.projectId));
    const language = project?.defaultLanguage ?? "en";
    const [ticket] = await tx
      .insert(tickets)
      .values({
        projectId: entry.projectId,
        subject,
        requesterEmail: sender.address,
        requesterName: sender.name,
        language,
        pendingSince: receivedAt,
      })
      .returning({ id: tickets.id, number: tickets.number, revision: tickets.revision });
    if (!ticket) throw new Error("ticket_creation_failed");
    // A reply to a ticket resolved long ago starts a linked follow-up.
    await insertMessage(ticket.id, language, target?.id);
    // An enabled project acknowledges a new ticket through its outgoing
    // connection, never to automatic mail and at most once an hour per sender.
    const connectionId = project?.settings.outboundConnectionId;
    if (
      project?.settings.acknowledgements === true &&
      typeof connectionId === "string" &&
      !isAutomaticMail(mail.headers, sender.address)
    ) {
      const [recent] = await tx
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(tickets, eq(tickets.id, messages.ticketId))
        .where(
          and(
            eq(tickets.projectId, entry.projectId),
            eq(tickets.requesterEmail, sender.address),
            eq(messages.authorType, "system"),
            sql`${messages.source}->>'kind' = 'acknowledgement'`,
            sql`${messages.createdAt} > now() - make_interval(secs => ${acknowledgementInterval / 1000})`,
          ),
        )
        .limit(1);
      if (!recent) {
        const [acknowledgement] = await tx
          .insert(messages)
          .values({
            ticketId: ticket.id,
            authorType: "system",
            authorName: project.name,
            markdown: acknowledgementText(language, ticket.number),
            language,
            deliveryState: "queued",
            source: { kind: "acknowledgement" },
          })
          .returning({ id: messages.id });
        if (!acknowledgement) throw new Error("acknowledgement_creation_failed");
        await tx.insert(jobs).values({
          projectId: entry.projectId,
          type: "mail.send",
          dedupKey: `acknowledgement:${ticket.id}`,
          payload: {
            ticketId: ticket.id,
            messageId: acknowledgement.id,
            connectionId,
            actorId: "system",
            actorKind: "system",
            expectedRevision: ticket.revision,
            resolve: false,
          },
        });
      }
    }
    return finish(ticket.id, "processed", target ? "follow_up" : "created");
  });
}
