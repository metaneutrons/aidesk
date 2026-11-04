import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { channelBody, channelKindOf, type ChannelValues } from "../domain/webhook-channel";
import { isChannel, signWebhook, type ChannelFormat } from "../domain/webhooks";
import { db } from "../server/db";
import { jobs, projects, tickets, webhookDeliveries, webhooks } from "../server/db/schema";
import { env } from "../server/env";
import { checkHost } from "../server/host-guard";
import { failureCode } from "../server/connections";
import { unsealSecret } from "../server/secrets";
// Delivers queued events to the endpoints of webhooks. A delivery is a signed
// POST with the event as its JSON body; a 2xx answer is success, anything else
// is tried again after a growing pause, and after the last attempt the job goes
// to review. Delivery is at least once: a receiver recognises an event by its
// id (X-Aidesk-Event-Id) and ignores one it has seen.
export const maxAttempts = 6;
export const backoffSeconds = [30, 120, 600, 3600, 21600];
const requestTimeout = 10_000;
const leaseMs = 60_000;
// What a channel is told about an event: read when the delivery is made, so that it names the ticket as it is now. A
// ticket that is gone is not announced.
async function channelValues(
  hook: typeof webhooks.$inferSelect,
  event: { type: string } & Record<string, unknown>,
  projectId: string,
): Promise<ChannelValues | "project" | "event" | "ticket"> {
  const [project] = await db().select().from(projects).where(eq(projects.id, projectId));
  if (!project) return "project";
  const data =
    typeof event.data === "object" && event.data !== null
      ? (event.data as Record<string, unknown>)
      : {};
  const kind = channelKindOf(event.type, data);
  if (!kind) return "event";
  const base = {
    kind,
    language: project.defaultLanguage === "de" ? ("de" as const) : ("en" as const),
    project: project.name,
  };
  if (kind === "ping") return { ...base, number: null, subject: null, url: null };
  const ticketId = z.uuid().safeParse(data.ticketId);
  if (!ticketId.success) return "ticket";
  const [ticket] = await db()
    .select({ id: tickets.id, number: tickets.number, subject: tickets.subject })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId.data), eq(tickets.projectId, projectId)));
  if (!ticket) return "ticket";
  return {
    ...base,
    number: ticket.number,
    subject: hook.withSubject ? ticket.subject : null,
    url: `${env().APP_URL}/?ticket=${ticket.id}`,
  };
}
const deliverPayload = z.object({
  webhookId: z.uuid(),
  event: z.object({ id: z.uuid(), type: z.string() }).loose(),
});
export async function runWebhooks(scope?: { projectId: string }): Promise<boolean> {
  const inScope = scope ? eq(jobs.projectId, scope.projectId) : undefined;
  // A delivery whose worker disappeared is queued again; the receiver dedupes.
  await db()
    .update(jobs)
    .set({ status: "queued", leaseUntil: null, runAfter: new Date() })
    .where(
      and(
        eq(jobs.status, "running"),
        eq(jobs.type, "webhook.deliver"),
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
          eq(jobs.type, "webhook.deliver"),
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
  const parsed = deliverPayload.safeParse(job.payload);
  const [hook] = parsed.success
    ? await db().select().from(webhooks).where(eq(webhooks.id, parsed.data.webhookId))
    : [];
  const started = Date.now();
  let status: number | null = null;
  let code: string | null = null;
  let permanent = false;
  // A delivery that is no longer wanted ends as skipped: the job succeeds, and the log says why nothing was sent.
  let skipped: string | null = null;
  if (!parsed.success || hook?.projectId !== job.projectId || hook.status !== "active") {
    code = "webhook_disabled";
    permanent = true;
  } else {
    try {
      const channel = isChannel(hook.format);
      // The address of a channel carries the key of the messenger and is kept sealed; the signing secret of the
      // other format is sealed in the same place.
      const sealedValue = unsealSecret(hook.secretCiphertext);
      const address = channel ? sealedValue : hook.url;
      const target = new URL(address);
      // The endpoint is checked again at every delivery; a development-only
      // webhook is exempt on a development stack, like a connection.
      if (!hook.developmentOnly && (await checkHost(target.hostname)) !== "allowed") {
        code = "host_refused";
        permanent = true;
      } else {
        let body = JSON.stringify(parsed.data.event);
        let headers: Record<string, string> = {};
        if (channel) {
          const values = await channelValues(hook, parsed.data.event, job.projectId);
          if (typeof values === "string") skipped = values;
          else body = JSON.stringify(channelBody(hook.format as ChannelFormat, values));
        } else {
          const timestamp = Math.floor(Date.now() / 1000);
          headers = {
            "x-aidesk-event": parsed.data.event.type,
            "x-aidesk-event-id": parsed.data.event.id,
            "x-aidesk-delivery-attempt": String(job.attempts),
            "x-aidesk-timestamp": String(timestamp),
            "x-aidesk-signature": signWebhook(sealedValue, timestamp, body),
          };
        }
        if (skipped === null) {
          const response = await fetch(address, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "user-agent": "aidesk-webhook/1",
              ...headers,
            },
            body,
            // An answer is never followed: a redirect could lead somewhere the
            // endpoint check did not allow.
            redirect: "manual",
            signal: AbortSignal.timeout(requestTimeout),
          });
          status = response.status;
          await response.body?.cancel();
          if (status < 200 || status >= 300)
            code = status >= 300 && status < 400 ? "redirect" : `http_${String(status)}`;
        }
      }
    } catch (error) {
      code = failureCode(error);
      if (error instanceof DOMException && error.name === "TimeoutError") code = "timeout";
    }
  }
  const succeeded = code === null;
  const last = permanent || job.attempts >= maxAttempts;
  const outcome =
    skipped !== null ? "skipped" : succeeded ? "succeeded" : last ? "failed" : "retry";
  if (hook)
    await db()
      .insert(webhookDeliveries)
      .values({
        webhookId: hook.id,
        projectId: job.projectId,
        eventId: parsed.success ? parsed.data.event.id : randomUUID(),
        event: parsed.success ? parsed.data.event.type : "unknown",
        attempt: job.attempts,
        outcome,
        responseStatus: status,
        code: skipped !== null ? `skipped:${skipped}` : code,
        durationMs: Date.now() - started,
      });
  await db()
    .update(jobs)
    .set(
      succeeded
        ? {
            status: "succeeded",
            leaseUntil: null,
            lastErrorCode: skipped !== null ? `skipped:${skipped}` : null,
          }
        : last
          ? { status: "review", leaseUntil: null, lastErrorCode: code }
          : {
              status: "queued",
              leaseUntil: null,
              lastErrorCode: code,
              runAfter: new Date(
                Date.now() +
                  1000 * (backoffSeconds[job.attempts - 1] ?? backoffSeconds.at(-1) ?? 60),
              ),
            },
    )
    .where(and(eq(jobs.id, job.id), eq(jobs.leaseToken, leaseToken), eq(jobs.status, "running")));
  console.log(
    JSON.stringify({ event: "webhook.delivery", jobId: job.id, outcome, code: skipped ?? code }),
  );
  return true;
}
