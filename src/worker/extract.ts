import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { extractionJob, recordExtraction } from "../server/attachment-text";
import { db } from "../server/db";
import { attachments, jobs } from "../server/db/schema";
import { extractSandboxed } from "../server/extract/sandbox";
import { getObject } from "../server/storage";
// Reads the text of the files that were asked for, one at a time, in the closed
// process. What the reading finds out about a file (encrypted, damaged, nothing to
// read) is a result and is kept. A failure of the machinery around it (the
// storage does not answer) is tried again after a pause, and after the last
// attempt the job goes to review.
export const maxAttempts = 5;
export const backoffSeconds = [30, 120, 600, 3600];
const leaseMs = 120_000;
const payload = z.object({ attachmentId: z.uuid() });
export async function runExtractions(scope?: { projectId: string }): Promise<boolean> {
  const inScope = scope ? eq(jobs.projectId, scope.projectId) : undefined;
  // A job whose worker disappeared is queued again; reading a file twice does no harm.
  await db()
    .update(jobs)
    .set({ status: "queued", leaseUntil: null, runAfter: new Date() })
    .where(
      and(
        eq(jobs.status, "running"),
        eq(jobs.type, extractionJob),
        sql`${jobs.leaseUntil} < now()`,
        inScope,
      ),
    );
  const leaseToken = randomUUID();
  const job = await db().transaction(async (tx) => {
    const [due] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "queued"),
          eq(jobs.type, extractionJob),
          sql`${jobs.runAfter} <= now()`,
          inScope,
        ),
      )
      .orderBy(jobs.runAfter)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!due) return null;
    const [claimed] = await tx
      .update(jobs)
      .set({
        status: "running",
        leaseToken,
        leaseUntil: new Date(Date.now() + leaseMs),
        attempts: due.attempts + 1,
      })
      .where(eq(jobs.id, due.id))
      .returning();
    return claimed ?? null;
  });
  if (!job) return false;
  const owned = and(
    eq(jobs.id, job.id),
    eq(jobs.leaseToken, leaseToken),
    eq(jobs.status, "running"),
  );
  const finish = async (set: Partial<typeof jobs.$inferInsert>, outcome: string) => {
    await db().update(jobs).set(set).where(owned);
    console.log(JSON.stringify({ event: "attachment.extract", jobId: job.id, outcome }));
  };
  const parsed = payload.safeParse(job.payload);
  const [file] = parsed.success
    ? await db()
        .select({ objectKey: attachments.objectKey })
        .from(attachments)
        .where(
          and(
            eq(attachments.id, parsed.data.attachmentId),
            eq(attachments.projectId, job.projectId),
          ),
        )
    : [];
  if (!parsed.success || !file) {
    await finish(
      { status: "review", leaseUntil: null, lastErrorCode: "attachment_missing" },
      "attachment_missing",
    );
    return true;
  }
  try {
    // A file that was refused on receipt has no bytes; there is nothing to read.
    const result = file.objectKey
      ? await extractSandboxed(await getObject(file.objectKey))
      : ({ ok: false, reason: "unsupported" } as const);
    await recordExtraction(job.projectId, parsed.data.attachmentId, result);
    await finish(
      { status: "succeeded", leaseUntil: null, lastErrorCode: null },
      result.ok ? "read" : result.reason,
    );
  } catch {
    const last = job.attempts >= maxAttempts;
    await finish(
      last
        ? { status: "review", leaseUntil: null, lastErrorCode: "extraction_unavailable" }
        : {
            status: "queued",
            leaseUntil: null,
            lastErrorCode: "extraction_unavailable",
            runAfter: new Date(
              Date.now() + 1000 * (backoffSeconds[job.attempts - 1] ?? backoffSeconds.at(-1) ?? 60),
            ),
          },
      last ? "review" : "retry",
    );
  }
  return true;
}
