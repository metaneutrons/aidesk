import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  erasureConfirm,
  requesterConfirm,
  requesterQuery,
  type ErasureCounts,
} from "../domain/erasure";
import { permits, type Principal } from "../domain/permissions";
import { db } from "./db";
import {
  agentRuns,
  attachments,
  audit,
  ingress,
  issueDrafts,
  jobs,
  messages,
  participants,
  portalBranding,
  projectExports,
  tickets,
  ticketIssues,
  translations,
} from "./db/schema";
import { DomainError } from "./errors";
import { deleteObjects } from "./storage";
// Erasing a ticket, or everything about one requester, from the database and the storage. It needs `data.erase` in
// the project, which no preset holds and the owner has only if the owner was given it as a member. Two steps: a
// preview names what would be removed and what cannot be reached any more; the confirmation sends the numbers back,
// and a different number now is a conflict. The removal is one transaction under a lock on the tickets; the files are
// removed afterwards, and only those that no other row still names (files are named by their content, so two
// messages can share one). The audit keeps counts and, for a requester, only a digest of the address; entries of the
// audit that name an erased ticket lose their detail. What was sent to a webhook, to a provider of mail or of models
// or into an export stays with them, and the result says so.
type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
type Reader = Pick<Tx, "select" | "execute">;
const id = z.uuid();
function eraser(principal: Principal, projectId: string): string {
  if (principal.kind !== "human" || !principal.active) throw new DomainError("forbidden", 403);
  const project = id.parse(projectId);
  if (!permits(principal, project, "data.erase")) throw new DomainError("not_found", 404);
  return project;
}
const digest = (email: string) => createHash("sha256").update(email).digest("hex");
interface Scope {
  project: string;
  ticketIds: string[];
  // The address of a requester, for what no ticket holds.
  email: string | null;
}
const list = (values: readonly string[]) =>
  sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
async function measure(tx: Reader, scope: Scope) {
  const { project, ticketIds, email } = scope;
  const ids = ticketIds.length ? ticketIds : [];
  const messageRows = ids.length
    ? await tx
        .select({ id: messages.id, rawObjectKey: messages.rawObjectKey })
        .from(messages)
        .where(inArray(messages.ticketId, ids))
    : [];
  const messageIds = messageRows.map((row) => row.id);
  const attachmentRows = messageIds.length
    ? await tx
        .select({ id: attachments.id, objectKey: attachments.objectKey })
        .from(attachments)
        .where(inArray(attachments.messageId, messageIds))
    : [];
  const ingressRows = await tx
    .select({ id: ingress.id, rawObjectKey: ingress.rawObjectKey })
    .from(ingress)
    .where(
      and(
        eq(ingress.projectId, project),
        or(
          ids.length ? inArray(ingress.ticketId, ids) : undefined,
          email ? sql`lower(${ingress.parsed}->>'from') = ${email}` : undefined,
        ),
      ),
    );
  const count = async (query: Promise<{ count: number }[]>) => (await query)[0]?.count ?? 0;
  const translationCount = messageIds.length
    ? await count(
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(translations)
          .where(inArray(translations.messageId, messageIds)),
      )
    : 0;
  const issueLinks = ids.length
    ? (await count(
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(ticketIssues)
          .where(inArray(ticketIssues.ticketId, ids)),
      )) +
      (await count(
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(issueDrafts)
          .where(inArray(issueDrafts.ticketId, ids)),
      ))
    : 0;
  const portal = await count(
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(participants)
      .where(
        or(
          ids.length ? inArray(participants.ticketId, ids) : undefined,
          email ? sql`lower(${participants.email}) = ${email}` : undefined,
        ),
      ),
  );
  const runs = ids.length
    ? await count(
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(agentRuns)
          .where(inArray(agentRuns.ticketId, ids)),
      )
    : 0;
  const jobRows = await tx.execute<{ id: string; type: string; status: string }>(sql`
    select id, type, status from ${jobs}
    where project_id = ${project} and (
      ${ids.length ? sql`payload->>'ticketId' = any(${list(ids)}) or payload->'event'->'data'->>'ticketId' = any(${list(ids)})` : sql`false`}
      ${messageIds.length ? sql`or payload->>'messageId' = any(${list(messageIds)})` : sql``}
      ${ingressRows.length ? sql`or payload->>'ingressId' = any(${list(ingressRows.map((row) => row.id))})` : sql``}
    )`);
  const counts: ErasureCounts = {
    tickets: ids.length,
    messages: messageIds.length,
    attachments: attachmentRows.filter((row) => row.objectKey !== null).length,
    // The original of a mail is one file, named by the message and by the entry of the mail that it came in with.
    originals: new Set([
      ...messageRows.flatMap((row) => (row.rawObjectKey ? [row.rawObjectKey] : [])),
      ...ingressRows.map((row) => row.rawObjectKey),
    ]).size,
    translations: translationCount,
    issueLinks,
    portalRecords: portal,
    runs,
    jobs: jobRows.length,
    ingress: ingressRows.length,
  };
  const delivered = jobRows.filter(
    (row) => row.type === "webhook.deliver" && row.status === "succeeded",
  ).length;
  const created = ids.length
    ? await count(
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(ticketIssues)
          .where(and(inArray(ticketIssues.ticketId, ids), eq(ticketIssues.origin, "created"))),
      )
    : 0;
  const exports = await count(
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(projectExports)
      .where(eq(projectExports.projectId, project)),
  );
  return {
    counts,
    outOfReach: { webhookEvents: delivered, issuesCreated: created, exports },
    messageIds,
    attachmentKeys: attachmentRows.flatMap((row) => (row.objectKey ? [row.objectKey] : [])),
    originalKeys: [
      ...messageRows.flatMap((row) => (row.rawObjectKey ? [row.rawObjectKey] : [])),
      ...ingressRows.map((row) => row.rawObjectKey),
    ],
    ingressIds: ingressRows.map((row) => row.id),
    jobIds: jobRows.map((row) => row.id),
  };
}
async function ticketsOf(tx: Reader, project: string, where: SQL) {
  return tx
    .select({ id: tickets.id, number: tickets.number, subject: tickets.subject })
    .from(tickets)
    .where(and(eq(tickets.projectId, project), where));
}
export async function previewTicketErasure(principal: Principal, ticketId: string) {
  const [row] = await db()
    .select({ projectId: tickets.projectId })
    .from(tickets)
    .where(eq(tickets.id, id.parse(ticketId)));
  if (!row) throw new DomainError("not_found", 404);
  const project = eraser(principal, row.projectId);
  const found = await ticketsOf(db(), project, eq(tickets.id, ticketId));
  const measured = await measure(db(), {
    project,
    ticketIds: found.map((entry) => entry.id),
    email: null,
  });
  return { counts: measured.counts, outOfReach: measured.outOfReach, tickets: found };
}
export async function previewRequesterErasure(
  principal: Principal,
  projectId: string,
  query: unknown,
) {
  const project = eraser(principal, projectId);
  const { email } = requesterQuery.parse(query);
  const found = await ticketsOf(db(), project, sql`lower(${tickets.requesterEmail}) = ${email}`);
  const measured = await measure(db(), {
    project,
    ticketIds: found.map((entry) => entry.id),
    email,
  });
  return { counts: measured.counts, outOfReach: measured.outOfReach, tickets: found };
}
async function run(
  principal: Principal,
  project: string,
  scopeOf: (tx: Tx) => Promise<Scope>,
  expected: ErasureCounts,
  detail: Record<string, unknown>,
) {
  const outcome = await db().transaction(async (tx) => {
    // The tickets are locked first, so that nothing is added while they are counted and removed.
    const scope = await scopeOf(tx);
    if (scope.ticketIds.length)
      await tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(inArray(tickets.id, scope.ticketIds))
        .for("update");
    const measured = await measure(tx, scope);
    if (JSON.stringify(measured.counts) !== JSON.stringify(expected))
      throw new DomainError("stale_version", 409);
    if (measured.jobIds.length) await tx.delete(jobs).where(inArray(jobs.id, measured.jobIds));
    // The detail of the audit entries about these tickets and their messages goes; the entries stay as facts.
    const named = [...scope.ticketIds, ...measured.messageIds];
    if (named.length)
      await tx
        .update(audit)
        .set({ detail: {} })
        .where(and(eq(audit.projectId, project), inArray(audit.targetId, named)));
    if (scope.email)
      await tx.delete(participants).where(sql`lower(${participants.email}) = ${scope.email}`);
    if (measured.ingressIds.length)
      await tx.delete(ingress).where(inArray(ingress.id, measured.ingressIds));
    // The rest follows the tickets: messages with their files and translations, links to issues, participants, runs.
    if (scope.ticketIds.length)
      await tx.delete(tickets).where(inArray(tickets.id, scope.ticketIds));
    await tx.insert(audit).values({
      projectId: project,
      actorId: principal.id,
      action: "data.erase",
      targetId: project,
      detail: { ...detail, counts: measured.counts, outOfReach: measured.outOfReach },
    });
    return measured;
  });
  // The files, after the commit: the ones that no row names any more.
  const keys = [...new Set([...outcome.attachmentKeys, ...outcome.originalKeys])];
  let shared = 0;
  const removable: string[] = [];
  if (keys.length) {
    const [attachmentUse, messageUse, ingressUse, exportUse, logoUse] = await Promise.all([
      db()
        .select({ key: attachments.objectKey })
        .from(attachments)
        .where(inArray(attachments.objectKey, keys)),
      db()
        .select({ key: messages.rawObjectKey })
        .from(messages)
        .where(inArray(messages.rawObjectKey, keys)),
      db()
        .select({ key: ingress.rawObjectKey })
        .from(ingress)
        .where(inArray(ingress.rawObjectKey, keys)),
      db()
        .select({ key: projectExports.objectKey })
        .from(projectExports)
        .where(inArray(projectExports.objectKey, keys)),
      db()
        .select({ key: portalBranding.logoKey })
        .from(portalBranding)
        .where(and(isNotNull(portalBranding.logoKey), inArray(portalBranding.logoKey, keys))),
    ]);
    const used = new Set(
      [...attachmentUse, ...messageUse, ...ingressUse, ...exportUse, ...logoUse].flatMap((row) =>
        row.key ? [row.key] : [],
      ),
    );
    for (const key of keys) {
      if (used.has(key)) shared += 1;
      else removable.push(key);
    }
  }
  const failed = removable.length ? await deleteObjects(removable) : [];
  return {
    counts: outcome.counts,
    objects: { removed: removable.length - failed.length, shared, failed: failed.length },
    outOfReach: outcome.outOfReach,
  };
}
export async function eraseTicket(principal: Principal, ticketId: string, input: unknown) {
  const { expected } = erasureConfirm.parse(input);
  const [row] = await db()
    .select({ projectId: tickets.projectId })
    .from(tickets)
    .where(eq(tickets.id, id.parse(ticketId)));
  if (!row) throw new DomainError("not_found", 404);
  const project = eraser(principal, row.projectId);
  const [numbered] = await db()
    .select({ number: tickets.number })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  return run(
    principal,
    project,
    () => Promise.resolve({ project, ticketIds: [ticketId], email: null }),
    expected,
    { scope: "ticket", ticket: numbered?.number ?? null },
  );
}
export async function eraseRequester(principal: Principal, projectId: string, input: unknown) {
  const project = eraser(principal, projectId);
  const { email, expected } = requesterConfirm.parse(input);
  return run(
    principal,
    project,
    async (tx) => ({
      project,
      ticketIds: (
        await ticketsOf(tx, project, sql`lower(${tickets.requesterEmail}) = ${email}`)
      ).map((entry) => entry.id),
      email,
    }),
    expected,
    { scope: "requester", requester: digest(email) },
  );
}
