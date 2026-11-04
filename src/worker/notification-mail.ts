import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { notificationKinds, preferenceDefaults } from "../domain/notifications";
import { notificationMailMarkdown, notificationMailSubject } from "../domain/notification-mail";
import { workspaceControls } from "../server/controls";
import { db } from "../server/db";
import { connections, notificationPreferences, projects, tickets, user } from "../server/db/schema";
import { activeEmailDesign } from "../server/email-design";
import { renderEmail } from "../server/email";
import { env } from "../server/env";
import { actionsOf } from "../server/grants";
import { claimJob } from "./claim";
import { deliver } from "./transport";
// The job that sends the mail of one notification to one operator, through the outgoing connection of the project. The
// checks are made again here, because the job may wait: the person may have left or lost the right to read, switched
// the mail off, the ticket may be gone, and the project may have paused its mail or changed its connection. A mail that
// is no longer wanted is not sent (a notification that comes late is worse than none), and the job ends as skipped.
// A failure of the transport is tried again after a pause, and after the last try the job goes to review.
const payload = z.object({
  userId: z.string(),
  kind: z.enum(notificationKinds),
  ticketId: z.uuid(),
});
const leaseMs = 2 * 60 * 1000;
export async function runNotificationMail(scope?: { projectId: string }): Promise<boolean> {
  const claimed = await claimJob("notify.mail", leaseMs, scope);
  if (!claimed) return false;
  const { job, finish, retry } = claimed;
  // The job ends as skipped, and the function answers that it did work.
  const skipped = async (reason: string): Promise<true> => {
    await finish(
      { status: "succeeded", leaseUntil: null, updatedAt: new Date() },
      `skipped:${reason}`,
    );
    return true;
  };
  let sent = false;
  try {
    const wanted = payload.parse(job.payload);
    const [project] = await db().select().from(projects).where(eq(projects.id, job.projectId));
    const connectionId =
      typeof project?.settings.outboundConnectionId === "string"
        ? project.settings.outboundConnectionId
        : null;
    if (!project || !connectionId) return await skipped("no_outbound");
    if (project.settings.pauseOutgoing === true || (await workspaceControls()).pauseOutgoing)
      return await skipped("paused");
    const [connection] = await db()
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.projectId, project.id),
          eq(connections.direction, "outbound"),
        ),
      );
    if (connection?.status !== "ready") return await skipped("not_ready");
    const [operator] = await db().select().from(user).where(eq(user.id, wanted.userId));
    if (!operator?.active || !operator.email) return await skipped("operator");
    if (!(await actionsOf(operator.id, project.id))?.includes("ticket.read"))
      return await skipped("no_rights");
    const [choice] = await db()
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, operator.id),
          eq(notificationPreferences.kind, wanted.kind),
        ),
      );
    if (!(choice?.mail ?? preferenceDefaults.mail)) return await skipped("switched_off");
    const [ticket] = await db()
      .select({ id: tickets.id, number: tickets.number, subject: tickets.subject })
      .from(tickets)
      .where(and(eq(tickets.id, wanted.ticketId), eq(tickets.projectId, project.id)));
    if (!ticket) return await skipped("ticket");
    const language =
      operator.locale === "de" || operator.locale === "en"
        ? operator.locale
        : project.defaultLanguage === "de"
          ? "de"
          : "en";
    const values = {
      project: project.name,
      number: ticket.number,
      subject: ticket.subject,
      url: `${env().APP_URL}/?ticket=${ticket.id}`,
    };
    const design = await activeEmailDesign(project.id, project.settings);
    const content = await renderEmail({
      project: project.name,
      markdown: notificationMailMarkdown(language, wanted.kind, values),
      language,
      color: project.color,
      fallbackLanguage: project.defaultLanguage,
      ...(design ? { design: design.config } : {}),
    });
    sent = true;
    await deliver({
      jobId: job.id,
      project,
      connection,
      localId: job.id,
      to: operator.email,
      subject: notificationMailSubject(language, wanted.kind, values),
      thread: {},
      content,
      ticketId: ticket.id,
      automatic: true,
      report: () => undefined,
    });
    await finish({ status: "succeeded", leaseUntil: null, updatedAt: new Date() }, "sent");
  } catch (error) {
    // A job that cannot be read is no use to anybody; any other failure is the transport's.
    if (error instanceof z.ZodError) await skipped("payload");
    else await retry(sent ? "transport_failed" : "preparation_failed");
  }
  return true;
}
