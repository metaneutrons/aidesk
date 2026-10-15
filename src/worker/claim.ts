import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import { jobs } from "../server/db/schema";
// The queue of one kind of job that is read file by file: take the next due job under
// a lease, give it back when its worker disappeared, and finish it with a status.
// A failure of the machinery around a job (the storage does not answer) is tried
// again after a pause, and after the last attempt the job goes to review.
export const maxAttempts = 5;
export const backoffSeconds = [30, 120, 600, 3600];
export type Job = typeof jobs.$inferSelect;
export interface Claimed {
  job: Job;
  finish: (set: Partial<typeof jobs.$inferInsert>, outcome: string) => Promise<void>;
  // The machinery failed: queue the job again after a pause, or send it to review.
  retry: (code: string) => Promise<void>;
}
export async function claimJob(
  type: string,
  leaseMs: number,
  scope?: { projectId: string },
): Promise<Claimed | null> {
  const inScope = scope ? eq(jobs.projectId, scope.projectId) : undefined;
  // A job whose worker disappeared is queued again.
  await db()
    .update(jobs)
    .set({ status: "queued", leaseUntil: null, runAfter: new Date() })
    .where(
      and(
        eq(jobs.status, "running"),
        eq(jobs.type, type),
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
          eq(jobs.type, type),
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
  if (!job) return null;
  const owned = and(
    eq(jobs.id, job.id),
    eq(jobs.leaseToken, leaseToken),
    eq(jobs.status, "running"),
  );
  const finish: Claimed["finish"] = async (set, outcome) => {
    await db().update(jobs).set(set).where(owned);
    console.log(JSON.stringify({ event: type, jobId: job.id, outcome }));
  };
  const retry: Claimed["retry"] = async (code) => {
    const last = job.attempts >= maxAttempts;
    await finish(
      last
        ? { status: "review", leaseUntil: null, lastErrorCode: code }
        : {
            status: "queued",
            leaseUntil: null,
            lastErrorCode: code,
            runAfter: new Date(
              Date.now() + 1000 * (backoffSeconds[job.attempts - 1] ?? backoffSeconds.at(-1) ?? 60),
            ),
          },
      last ? "review" : "retry",
    );
  };
  return { job, finish, retry };
}
