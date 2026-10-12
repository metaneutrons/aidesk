import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { ingress, jobs } from "./db/schema";
import { processIngress } from "./inbound";
import { syncImapJunk } from "./imap";
// Jobs that may run more than once without harm: inbound processing and
// moving IMAP originals in or out of the junk folder. A lost lease is simply
// requeued; transient failures retry with jittered backoff, at most six
// attempts in about a day; permanent failures go to review.
const backoffMinutes = [1, 5, 30, 120, 360, 1440];
const leaseMs = 120_000;
const payload = z.object({ ingressId: z.uuid() });
const handlers = {
  "mail.ingest": (ingressId: string) => processIngress(ingressId),
  "mail.junk_sync": (ingressId: string) => syncImapJunk(ingressId),
} as const;
type IdempotentJob = keyof typeof handlers;
const types = Object.keys(handlers) as IdempotentJob[];
const permanent = new Set([
  "inbound_sender_missing",
  "ingress_missing",
  "imap_uidvalidity_changed",
  "imap_message_missing",
]);
// The state of an IMAP junk move is kept on the mail, so the junk view can
// show whether the original has followed.
async function recordJunkSync(ingressId: string, state: string, code?: string) {
  await db()
    .update(ingress)
    .set({
      origin: sql`coalesce(${ingress.origin}, '{}'::jsonb) || ${JSON.stringify({
        junkSync: { state, ...(code ? { code } : {}), at: new Date().toISOString() },
      })}::jsonb`,
    })
    .where(eq(ingress.id, ingressId));
}
// The worker runs any due job; a project scope keeps parallel tests apart.
export async function runIdempotentJob(
  scope: { projectId?: string } = {},
): Promise<{ type: string; outcome: string } | null> {
  const inScope = scope.projectId ? eq(jobs.projectId, scope.projectId) : undefined;
  await db()
    .update(jobs)
    .set({ status: "retry", leaseUntil: null, updatedAt: new Date() })
    .where(
      and(
        eq(jobs.status, "running"),
        inArray(jobs.type, types),
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
          inArray(jobs.status, ["queued", "retry"]),
          inArray(jobs.type, types),
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
  const type = job.type as IdempotentJob;
  const owned = and(eq(jobs.id, job.id), eq(jobs.leaseToken, leaseToken));
  const parsed = payload.safeParse(job.payload);
  try {
    if (!parsed.success) throw new Error("ingress_missing");
    const outcome = await handlers[type](parsed.data.ingressId);
    await db()
      .update(jobs)
      .set({ status: "succeeded", leaseUntil: null, updatedAt: new Date() })
      .where(owned);
    if (type === "mail.junk_sync") await recordJunkSync(parsed.data.ingressId, "done");
    return { type, outcome };
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 64) : "job_failed";
    const delay = backoffMinutes[job.attempts - 1];
    const final = permanent.has(code) || delay === undefined;
    await db()
      .update(jobs)
      .set(
        final
          ? { status: "review", lastErrorCode: code, leaseUntil: null, updatedAt: new Date() }
          : {
              status: "retry",
              lastErrorCode: code,
              leaseUntil: null,
              runAfter: new Date(Date.now() + delay * 60_000 * (0.8 + Math.random() * 0.4)),
              updatedAt: new Date(),
            },
      )
      .where(owned);
    if (type === "mail.junk_sync" && parsed.success)
      await recordJunkSync(parsed.data.ingressId, final ? "failed" : "retrying", code);
    return { type, outcome: `failed:${code}` };
  }
}
