import { and, eq, inArray } from "drizzle-orm";
import type { AiFailure } from "../domain/ai";
import { db } from "./db";
import { aiProfiles, attachmentTexts, jobs } from "./db/schema";
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
// Why a file has no text: what the reader found out, or how a run of the model ended.
export type ReadFailure = Failure | AiFailure;
// A text that a model read is marked by its method, which names the model.
export const modelMethod = (model: string) => `ai:${model}`;
export const isModelMethod = (method: string | null | undefined): boolean =>
  method?.startsWith("ai:") === true;
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
  | { state: "failed"; failure: ReadFailure }
  | { state: "pending" };
// Where the extraction of a file stands, and a job queued when nothing exists yet.
export async function textState(projectId: string, attachmentId: string): Promise<TextState> {
  const [record] = await db()
    .select()
    .from(attachmentTexts)
    .where(eq(attachmentTexts.attachmentId, attachmentId));
  // A reading by a model costs money and is not made again when the reader of
  // documents changes.
  if (record && (record.version === extractorVersion || isModelMethod(record.method))) {
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
    return { state: "failed", failure: (record.failure ?? "failed") as ReadFailure };
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
// The reading of a file by a model, for an image or a scan: a job of its own that
// asks the model once. A project that has not switched the task on gets no job and
// no cost. The result is kept with the file like any other text. A run that ended
// without an answer for a reason of the moment (a timeout, the budget, a provider
// that failed) is not repeated by the worker; the next request for the file, after
// a pause, asks again.
export const imageJob = "attachment.read_image";
export const imageKey = (attachmentId: string) => `image:${attachmentId}`;
export const retryAfterMs = 5 * 60 * 1000;
export type ModelState = TextState | { state: "off" };
const isAiFailure = (failure: string | null): boolean => failure?.startsWith("ai_") === true;
export async function modelState(
  projectId: string,
  attachmentId: string,
  asked: { id: string; kind: "human" | "agent" | "system" },
  now = Date.now(),
): Promise<ModelState> {
  const [profile] = await db()
    .select({ enabled: aiProfiles.enabled })
    .from(aiProfiles)
    .where(and(eq(aiProfiles.projectId, projectId), eq(aiProfiles.task, "image.read")));
  if (!profile?.enabled) return { state: "off" };
  const [record] = await db()
    .select()
    .from(attachmentTexts)
    .where(eq(attachmentTexts.attachmentId, attachmentId));
  const modelRecord = record && isModelMethod(record.method) ? record : null;
  if (modelRecord?.text != null) return await textState(projectId, attachmentId);
  const expired = now - (modelRecord?.createdAt.getTime() ?? now) >= retryAfterMs;
  if (modelRecord && !(isAiFailure(modelRecord.failure) && expired))
    return { state: "failed", failure: (modelRecord.failure ?? "failed") as ReadFailure };
  const [job] = await db()
    .select({ status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.dedupKey, imageKey(attachmentId)), eq(jobs.type, imageJob)));
  // A job that went to review will not run again by itself.
  if (job?.status === "review") return { state: "failed", failure: "failed" };
  if (!job) {
    await db()
      .insert(jobs)
      .values({
        projectId,
        type: imageJob,
        dedupKey: imageKey(attachmentId),
        payload: { attachmentId, asked },
      })
      .onConflictDoNothing();
  } else if (job.status === "succeeded") {
    // The run is over and its result was not kept (or may be asked for again).
    await db()
      .update(jobs)
      .set({
        status: "queued",
        attempts: 0,
        runAfter: new Date(),
        leaseUntil: null,
        payload: { attachmentId, asked },
      })
      .where(and(eq(jobs.dedupKey, imageKey(attachmentId)), inArray(jobs.status, ["succeeded"])));
  }
  return { state: "pending" };
}
// Keeps what a model made of a file, or why it made nothing, replacing an older record.
export async function recordModelReading(
  projectId: string,
  attachmentId: string,
  model: string,
  result: { ok: true; text: string; truncated: boolean } | { ok: false; failure: ReadFailure },
): Promise<void> {
  const values = result.ok
    ? { text: result.text, truncated: result.truncated, units: 1, failure: null }
    : { text: null, truncated: false, units: 0, failure: result.failure };
  const record = {
    method: modelMethod(model),
    unit: "file",
    hidden: 0,
    version: extractorVersion,
    ...values,
  };
  await db()
    .insert(attachmentTexts)
    .values({ attachmentId, projectId, ...record })
    .onConflictDoUpdate({
      target: attachmentTexts.attachmentId,
      set: { createdAt: new Date(), ...record },
    });
}
