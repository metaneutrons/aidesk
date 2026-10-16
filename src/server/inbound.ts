import { createHash } from "node:crypto";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { simpleParser, type AddressObject } from "mailparser";
import TurndownService from "turndown";
import type { Tx } from "./changes";
import { db } from "./db";
import { attachments, ingress, jobs, messages, projects, tickets } from "./db/schema";
import { getObject, putObject } from "./storage";
import { extractReply } from "../domain/extraction";
import { classifyJunk } from "../domain/junk";
import { assemble, textLines, type ExtractResult, type JunkResult } from "../domain/intake";
import type { AiDeps } from "./ai-run";
import { runIntakeAi } from "./intake-ai";
import { attachmentRefusal, safeFilename } from "../domain/attachments";
import {
  acknowledgementInterval,
  acknowledgementText,
  isAutomaticMail,
} from "../domain/acknowledgement";
import { isMessageId } from "../domain/threading";
import { activeTexts } from "./texts";
import { queueAgentRun } from "./agent-runs";
import { emitEvent } from "./webhooks";
import { parseDeliveryReport } from "../domain/bounce";
import { decideLanguage, detectLanguage } from "../domain/language";
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
  origin?: Record<string, unknown>;
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
        origin: input.origin ?? null,
      })
      .onConflictDoNothing({ target: [ingress.projectId, ingress.externalKey] })
      .returning({ id: ingress.id });
    if (!created) {
      const [existing] = await tx
        .select({ id: ingress.id })
        .from(ingress)
        .where(
          and(eq(ingress.projectId, input.projectId), eq(ingress.externalKey, input.externalKey)),
        );
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
// The ticket that a reply continues: a reference to one of its messages in this project, from the
// requester of the ticket. Claimed identifiers alone, or another sender, find none.
async function findTarget(
  reader: Pick<Tx, "select">,
  projectId: string,
  references: string[],
  sender: string,
): Promise<typeof tickets.$inferSelect | undefined> {
  if (!references.length) return undefined;
  const [match] = await reader
    .select({ ticket: tickets })
    .from(messages)
    .innerJoin(tickets, eq(tickets.id, messages.ticketId))
    .where(
      and(
        eq(tickets.projectId, projectId),
        or(
          inArray(messages.receivedMessageId, references),
          inArray(sql<string>`${messages.source}->>'messageId'`, references),
        ),
      ),
    )
    .orderBy(sql`${messages.createdAt} desc`)
    .limit(1);
  return match?.ticket.requesterEmail.toLowerCase() === sender ? match.ticket : undefined;
}
// A header value of the parser as text: most are strings, some are objects with a value.
function headerText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
// What the stored results of an earlier run of this mail say, for a mail that is processed again.
function storedAi(classification: Record<string, unknown> | null) {
  const ai = classification?.ai;
  return typeof ai === "object" && ai !== null
    ? (ai as { extract?: ExtractResult; junk?: JunkResult })
    : undefined;
}
export type IngestOutcome =
  "created" | "appended" | "reopened" | "duplicate" | "follow_up" | "junk" | "bounced" | "report";
export async function processIngress(
  ingressId: string,
  deps: AiDeps = {},
): Promise<IngestOutcome | "done"> {
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
  const text = body.trim() ? body : "(no text content)";
  const parser = extractReply(text);
  const references = referenceIds(mail.inReplyTo, mail.references);
  const subject = (mail.subject ?? "").trim() || "(no subject)";
  const receivedAt = entry.receivedAt;
  // What is known without a transaction, and what the AI steps of intake need: a mail that the
  // rules keep out, a delivery report and a copy of a mail that is already in are not asked
  // about, and a reply to a ticket is not asked whether it is junk.
  const ruleVerdict = entry.classification?.restored ? null : classifyJunk(mail.headers);
  const report = parseDeliveryReport(
    mail.headers.get("content-type"),
    mail.text ?? "",
    mail.attachments
      .filter((file) => ["text/rfc822-headers", "message/rfc822"].includes(file.contentType))
      .map((file) => file.content.toString("utf8")),
  );
  const [known] = messageId
    ? await db()
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(tickets, eq(tickets.id, messages.ticketId))
        .where(
          and(eq(tickets.projectId, entry.projectId), eq(messages.receivedMessageId, messageId)),
        )
        .limit(1)
    : [];
  const ai =
    ruleVerdict?.junk || report?.originalMessageId || known
      ? { extract: null, junk: null }
      : await runIntakeAi(
          {
            projectId: entry.projectId,
            ingressId: entry.id,
            subject,
            from: `${sender.name} <${sender.address}>`,
            body: text,
            attachments: mail.attachments.length,
            signals: [
              // The parser gathers the List-* headers under `list`.
              ...(mail.headers.has("list") ? ["list-unsubscribe"] : []),
              ...(/^(bulk|list|junk)$/i.test(headerText(mail.headers.get("precedence")))
                ? ["precedence-bulk"]
                : []),
              ...(mail.headers.has("auto-submitted") ? ["auto-submitted"] : []),
            ],
            wantJunk:
              !entry.classification?.restored &&
              !(await findTarget(db(), entry.projectId, references, sender.address)),
            stored: storedAi(entry.classification),
          },
          deps,
        );
  // The new content: what the model chose, from the lines of the mail, when it chose well;
  // otherwise what the parser found. The parser result stays with the message either way.
  const chosen = ai.extract?.state === "ok" ? assemble(textLines(text), ai.extract.keep) : null;
  const extraction =
    ai.extract?.state === "ok" && chosen !== null
      ? { markdown: chosen, trimmed: chosen !== text.trim(), uncertain: ai.extract.uncertain }
      : parser;
  const detection = detectLanguage(extraction.markdown);
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
    // A byte-identical copy of a mail a person restored from junk, such as the
    // original moved back into the polled mailbox, is the same message.
    if (!entry.classification?.restored) {
      const [restoredCopy] = await tx
        .select({ id: ingress.id, ticketId: ingress.ticketId })
        .from(ingress)
        .where(
          and(
            eq(ingress.projectId, entry.projectId),
            eq(ingress.checksum, entry.checksum),
            ne(ingress.id, entry.id),
            sql`${ingress.classification} ? 'restored'`,
          ),
        )
        .limit(1);
      if (restoredCopy) return finish(restoredCopy.ticketId, "duplicate", "duplicate");
    }
    // Junk stays out of the inbox: no ticket, nothing added to an existing
    // ticket, no acknowledgement. A restored mail is not classified again.
    const keepOut = async (reason: string, by: "rules" | "ai") => {
      // The original in an IMAP mailbox follows into its junk folder.
      if (entry.origin?.kind === "imap")
        await tx.insert(jobs).values({
          projectId: entry.projectId,
          type: "mail.junk_sync",
          dedupKey: `junk-sync:${entry.id}:junk`,
          payload: { ingressId: entry.id },
        });
      // Merged into what is stored, which holds the results of the AI steps.
      await tx
        .update(ingress)
        .set({
          classification: sql`coalesce(${ingress.classification}, '{}'::jsonb) || ${JSON.stringify({
            verdict: "junk",
            reason,
            source: by,
            at: new Date().toISOString(),
          })}::jsonb`,
        })
        .where(eq(ingress.id, entry.id));
      return finish(null, "junk", "junk");
    };
    if (ruleVerdict?.junk) return keepOut(ruleVerdict.reason ?? "rules", "rules");
    // A delivery report for one of our sent messages belongs to that message,
    // not to a new ticket. It must name our identifier and the recipient we
    // wrote to; anything else is processed like other mail.
    if (report?.originalMessageId) {
      const [sent] = await tx
        .select({ message: messages, ticket: tickets })
        .from(messages)
        .innerJoin(tickets, eq(tickets.id, messages.ticketId))
        .where(
          and(
            eq(tickets.projectId, entry.projectId),
            inArray(messages.deliveryState, ["sent", "review"]),
            sql`${messages.source}->>'messageId' = ${report.originalMessageId}`,
          ),
        )
        .limit(1)
        .for("update", { of: [messages, tickets] });
      const addressed = sent?.ticket.requesterEmail.toLowerCase() === report.recipient;
      if (sent && addressed) {
        // Further reports about a failure already recorded change nothing.
        if (report.action !== "failed" || sent.message.source.deliveryError === "bounced")
          return finish(sent.ticket.id, "processed", "report");
        await tx
          .update(messages)
          .set({
            deliveryState: "review",
            source: {
              ...sent.message.source,
              deliveryError: "bounced",
              bounce: { status: report.status, diagnostic: report.diagnostic, at: receivedAt },
            },
          })
          .where(eq(messages.id, sent.message.id));
        // A reply that did not arrive leaves the obligation to answer open, except
        // for an acknowledgement, which was never an answer.
        if (sent.message.source.kind !== "acknowledgement" && sent.ticket.junkAt === null)
          await tx
            .update(tickets)
            .set({
              status: "open",
              resolvedAt: null,
              pendingSince: sent.ticket.pendingSince ?? receivedAt,
              revision: sql`${tickets.revision} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(tickets.id, sent.ticket.id));
        return finish(sent.ticket.id, "processed", "bounced");
      }
    }
    // A reply continues a ticket only through a reference to one of its
    // messages in this project and only from the ticket's requester. Claimed
    // identifiers alone, or another sender, start a separate ticket.
    const target = await findTarget(tx, entry.projectId, references, sender.address);
    // The model's verdict can only add to the rules: a mail that starts a ticket and that it
    // calls junk stays out of the inbox, where a person can restore it. A reply to a ticket was
    // not asked about, and what it was not sure about is a ticket like any other, marked.
    if (!target && ai.junk?.state === "junk") return keepOut(ai.junk.reason, "ai");
    const usedAi = ai.extract?.state === "ok" && chosen !== null;
    const source = {
      from: sender.address,
      subject,
      extraction: usedAi ? "ai" : "parser",
      trimmed: extraction.trimmed,
      uncertain: extraction.uncertain,
      // What the AI step did, when it ran: the parser result stays, so a person can compare, and
      // a failure says why the parser result was kept.
      ...(ai.extract?.state === "ok" && usedAi
        ? {
            parser: {
              markdown: parser.markdown,
              trimmed: parser.trimmed,
              uncertain: parser.uncertain,
            },
            aiExtraction: { runId: ai.extract.runId },
          }
        : {}),
      ...(ai.extract && !usedAi
        ? {
            extractionFailure: ai.extract.state === "ok" ? "bad_selection" : ai.extract.code,
          }
        : {}),
      attachments: mail.attachments.length,
      languageDetection: { language: detection.language, reason: detection.reason },
    };
    // The messages this mail added, announced once the ticket is known.
    const messageIds: string[] = [];
    const insertMessage = async (
      ticketId: string,
      language: string,
      followUpOf?: string,
      decision?: object,
    ) => {
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
          source: { ...source, ...(followUpOf ? { followUpOf } : {}), ...decision },
          createdAt: receivedAt,
        })
        .returning({ id: messages.id });
      if (!message) throw new Error("message_creation_failed");
      messageIds.push(message.id);
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
      // The ticket keeps its language; the message records what it was written in.
      await insertMessage(target.id, detection.language ?? target.language);
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
      await emitEvent(tx, entry.projectId, "message.received", {
        ticketId: target.id,
        number: target.number,
        messageId: messageIds[0] ?? null,
        channel: "email",
      });
      if (target.status !== "open")
        await emitEvent(tx, entry.projectId, "ticket.status_changed", {
          ticketId: target.id,
          number: target.number,
          from: target.status,
          to: "open",
        });
      // A managed agent that works the ticket answers the new message.
      await queueAgentRun(tx, target.id, "message");
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
    // A new ticket takes the language of its first message when that is clear,
    // otherwise the project's default. The outcome is kept visible.
    const decision = decideLanguage({
      detection,
      projectDefault: project?.defaultLanguage ?? "en",
    });
    const language = decision.language;
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
    await insertMessage(ticket.id, language, target?.id, {
      languageDecision: { source: decision.source, undecided: decision.undecided },
      // What the model said about junk, when it was asked: a mail it was not sure about, or
      // that it could not judge, is in the inbox and is not acknowledged.
      ...(ai.junk
        ? {
            junkCheck:
              ai.junk.state === "failed"
                ? { result: "failed", code: ai.junk.code }
                : {
                    result: ai.junk.state === "support" ? "clean" : "uncertain",
                    reason: ai.junk.reason,
                  },
          }
        : {}),
    });
    // An enabled project acknowledges a new ticket through its outgoing
    // connection, never to automatic mail and at most once an hour per sender.
    const connectionId = project?.settings.outboundConnectionId;
    if (
      project?.settings.acknowledgements === true &&
      typeof connectionId === "string" &&
      !isAutomaticMail(mail.headers, sender.address) &&
      // A mail that the model could not clear is not answered by the product before a person
      // has looked at it.
      (ai.junk === null || ai.junk.state === "support")
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
            markdown: acknowledgementText(
              language,
              ticket.number,
              (await activeTexts(entry.projectId, language)).acknowledgement,
            ),
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
    await emitEvent(tx, entry.projectId, "ticket.created", {
      ticketId: ticket.id,
      number: ticket.number,
      subject,
      language,
    });
    await emitEvent(tx, entry.projectId, "message.received", {
      ticketId: ticket.id,
      number: ticket.number,
      messageId: messageIds[0] ?? null,
      channel: "email",
    });
    return finish(ticket.id, "processed", target ? "follow_up" : "created");
  });
}
