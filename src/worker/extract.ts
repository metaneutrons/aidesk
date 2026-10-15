import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { extractionJob, recordExtraction } from "../server/attachment-text";
import { db } from "../server/db";
import { attachments } from "../server/db/schema";
import { extractSandboxed } from "../server/extract/sandbox";
import { getObject } from "../server/storage";
import { claimJob } from "./claim";
// Reads the text of the files that were asked for, one at a time, in the closed
// process. What the reading finds out about a file (encrypted, damaged, nothing to
// read) is a result and is kept. A failure of the machinery around it (the
// storage does not answer) is tried again after a pause, and after the last
// attempt the job goes to review.
export { maxAttempts } from "./claim";
const leaseMs = 120_000;
const payload = z.object({ attachmentId: z.uuid() });
export async function runExtractions(scope?: { projectId: string }): Promise<boolean> {
  // A job whose worker disappeared is queued again; reading a file twice does no harm.
  const claimed = await claimJob(extractionJob, leaseMs, scope);
  if (!claimed) return false;
  const { job, finish, retry } = claimed;
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
    await retry("extraction_unavailable");
  }
  return true;
}
