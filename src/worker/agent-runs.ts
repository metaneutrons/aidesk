import { eq } from "drizzle-orm";
import { z } from "zod";
import { endRun, runJob, staleReason } from "../server/agent-runs";
import { db } from "../server/db";
import { agentRuns } from "../server/db/schema";
import { claimJob } from "./claim";
// Takes the next run of a managed agent. The checks come first: a run whose ticket was
// taken over, reassigned, resolved, stopped or answered by a newer message ends without
// doing anything. What a run does when it may go on is the runner of the next part; until
// that exists a run ends as needing a person, which is visible on the ticket.
const payload = z.object({
  ticketId: z.uuid(),
  agentId: z.uuid(),
  revision: z.number().int(),
  trigger: z.enum(["assignment", "message"]),
});
const leaseMs = 10 * 60 * 1000;
export async function runAgents(scope?: { projectId: string }): Promise<boolean> {
  const claimed = await claimJob(runJob, leaseMs, scope);
  if (!claimed) return false;
  const { job, finish } = claimed;
  const parsed = payload.safeParse(job.payload);
  const [run] = parsed.success
    ? await db().select().from(agentRuns).where(eq(agentRuns.jobId, job.id))
    : [];
  if (!run) {
    await finish(
      { status: "review", leaseUntil: null, lastErrorCode: "run_missing" },
      "run_missing",
    );
    return true;
  }
  const stale = await staleReason(run.id);
  if (stale) {
    await endRun(run.id, "cancelled", stale);
    await finish({ status: "cancelled", leaseUntil: null, lastErrorCode: stale }, stale);
    return true;
  }
  await db()
    .update(agentRuns)
    .set({ state: "running", startedAt: new Date() })
    .where(eq(agentRuns.id, run.id));
  await endRun(run.id, "needs_person", "runner_not_available");
  await finish({ status: "succeeded", leaseUntil: null }, "needs_person");
  return true;
}
