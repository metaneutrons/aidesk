import nodemailer from "nodemailer";
import type { connections, projects } from "../server/db/schema";
import { unseal } from "../server/crypto";
import { env } from "../server/env";
import { classifySmtpFailure, smtpProgress } from "../domain/delivery";
import { smtp2goSuppressed } from "../server/smtp2go";
import { smtpConfig, smtpSecret } from "../domain/connections";
import { parseCloudflareOutbound, sendViaCloudflare } from "../server/cloudflare";
// Hands one mail to the outgoing connection of a project. Shared by replies
// and test mails, so both go through the same configuration checks, the same
// suppression check and the same classification of failures. `report` receives
// the code that describes the failure if this function throws: it starts at the
// general review code, and says "unknown" from the moment the mail may have
// left.

// Marks automatic mail (RFC 3834) and asks Exchange not to answer it with
// its own automatic replies.
const automaticHeaders = {
  "Auto-Submitted": "auto-replied",
  "X-Auto-Response-Suppress": "All",
};
export interface Delivery {
  jobId: string;
  project: typeof projects.$inferSelect;
  connection: typeof connections.$inferSelect;
  // The local part of the Message-ID of an SMTP mail, unique per mail.
  localId: string;
  to: string;
  subject: string;
  thread: { inReplyTo?: string; references?: string };
  content: { html: string; text: string };
  ticketId: string;
  automatic: boolean;
  report: (code: string) => void;
}
export async function deliver(input: Delivery): Promise<{
  outgoingId: string | null;
  sender: { from: string; replyTo: string };
}> {
  const { project, connection, to, subject, thread, content, report } = input;
  if (connection.kind === "cloudflare") {
    const { config, secret } = parseCloudflareOutbound(
      connection.config,
      connection.secretCiphertext,
    );
    report("transport_acceptance_unknown");
    try {
      const sent = await sendViaCloudflare(config, secret, {
        fromName: project.name,
        to,
        subject,
        ...thread,
        ...content,
        ticketId: input.ticketId,
        automatic: input.automatic,
      });
      return {
        outgoingId: sent.messageId,
        sender: { from: config.from, replyTo: config.replyTo },
      };
    } catch (error) {
      if (error instanceof Error && error.message === "transport_rejected") report(error.message);
      throw error;
    }
  }
  if (connection.kind !== "smtp") throw new Error("outbound_not_ready");
  const config = smtpConfig.parse(connection.config);
  if (
    config.developmentOnly &&
    (process.env.NODE_ENV !== "development" || process.env.DEV_BOOTSTRAP !== "true")
  )
    throw new Error("development_connection_not_allowed");
  const secret = connection.secretCiphertext
    ? smtpSecret.parse(JSON.parse(unseal(connection.secretCiphertext, env().ENCRYPTION_KEY)))
    : undefined;
  if (!config.developmentOnly && !config.secure && config.port !== 587)
    throw new Error("smtp_tls_required");
  if (config.suppressionCheck === "smtp2go") {
    report("suppression_check_failed");
    if (!secret?.apiKey) throw new Error("suppression_check_failed");
    if (await smtp2goSuppressed(secret.apiKey, to)) {
      report("recipient_suppressed");
      throw new Error("recipient_suppressed");
    }
    report("dispatch_needs_review");
  }
  const progress = smtpProgress();
  const transport = nodemailer.createTransport({
    transactionLog: true,
    logger: progress.logger,
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.developmentOnly && !config.secure,
    auth: secret ? { user: secret.user, pass: secret.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  report("transport_acceptance_unknown");
  const senderDomain = config.from.slice(config.from.lastIndexOf("@") + 1);
  const outgoingId = `<${input.localId}@${senderDomain}>`;
  const accepted = await transport
    .sendMail({
      from: { name: project.name, address: config.from },
      replyTo: config.replyTo,
      to,
      subject,
      messageId: outgoingId,
      ...thread,
      headers: {
        "X-Aidesk-Ticket": input.ticketId,
        ...(input.automatic ? automaticHeaders : {}),
      },
      ...content,
    })
    .catch((error: unknown) => {
      const failure = classifySmtpFailure(error, progress.dataSent);
      report(failure.outcome);
      console.log(JSON.stringify({ event: "smtp.send_failed", jobId: input.jobId, ...failure }));
      throw error;
    });
  if (!accepted.accepted.map(String).includes(to)) throw new Error("recipient_not_accepted");
  return { outgoingId, sender: { from: config.from, replyTo: config.replyTo } };
}
