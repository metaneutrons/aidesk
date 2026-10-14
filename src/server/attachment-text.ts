import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { attachmentTexts, jobs } from "./db/schema";
import type { Extraction, Failure } from "./extract/types";
// The text of a file that is not plain text, read by the worker once and kept
// with the file. The first request for it queues the job and answers that it is
// pending; once the job has run, every read gives the same record. A result of
// an older reader (another version) is not used, and asking again queues the job
// for the new version.
export const extractorVersion = 1;
export const extractionJob = "attachment.extract";
export const extractionKey = (attachmentId: string) =>
  `extract:${attachmentId}:v${String(extractorVersion)}`;
export type TextState =
  | {
      state: "ready";
      text: string;
      method: string;
      unit: string;
      units: number;
      truncated: boolean;
      hidden: number;
    }
  | { state: "failed"; failure: Failure }
  | { state: "pending" };
// Where the extraction of a file stands, and a job queued when nothing exists yet.
export async function textState(projectId: string, attachmentId: string): Promise<TextState> {
  const [record] = await db()
    .select()
    .from(attachmentTexts)
    .where(eq(attachmentTexts.attachmentId, attachmentId));
  if (record?.version === extractorVersion) {
    if (record.text !== null)
      return {
        state: "ready",
        text: record.text,
        method: record.method ?? "",
        unit: record.unit ?? "pages",
        units: record.units,
        truncated: record.truncated,
        hidden: record.hidden,
      };
    return { state: "failed", failure: (record.failure ?? "failed") as Failure };
  }
  const [job] = await db()
    .select({ status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.dedupKey, extractionKey(attachmentId)), eq(jobs.type, extractionJob)));
  // A job that went to review will not run again by itself.
  if (job?.status === "review") return { state: "failed", failure: "failed" };
  if (!job)
    await db()
      .insert(jobs)
      .values({
        projectId,
        type: extractionJob,
        dedupKey: extractionKey(attachmentId),
        payload: { attachmentId },
      })
      .onConflictDoNothing();
  return { state: "pending" };
}
// Keeps the result of a reading, replacing an older one of the same file.
export async function recordExtraction(
  projectId: string,
  attachmentId: string,
  result: Extraction,
): Promise<void> {
  const values = result.ok
    ? {
        method: result.method,
        text: result.text,
        unit: result.unit,
        units: result.units,
        truncated: result.truncated,
        hidden: result.hidden,
        failure: null,
      }
    : {
        method: null,
        text: null,
        unit: null,
        units: 0,
        truncated: false,
        hidden: 0,
        failure: result.reason,
      };
  await db()
    .insert(attachmentTexts)
    .values({ attachmentId, projectId, version: extractorVersion, ...values })
    .onConflictDoUpdate({
      target: attachmentTexts.attachmentId,
      set: { version: extractorVersion, createdAt: new Date(), ...values },
    });
}
