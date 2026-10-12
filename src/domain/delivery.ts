// Classifies a failed SMTP submission. A reply from the server that is not a
// success means the server did not take responsibility for the message, so
// it was not sent; the same holds for a failed connection or login before the
// message was handed over. Anything else, such as a timeout or a dropped
// connection after the DATA command, leaves acceptance unknown and must not be
// retried automatically.
export interface SmtpFailure {
  outcome: "transport_rejected" | "transport_acceptance_unknown";
  command: string | null;
  responseCode: number | null;
  // Enhanced status code (RFC 3463) from the reply, for example 5.7.1.
  status: string | null;
}
function field(error: unknown, name: string): unknown {
  return typeof error === "object" && error !== null && name in error
    ? (error as Record<string, unknown>)[name]
    : undefined;
}
export function classifySmtpFailure(error: unknown, dataSent = false): SmtpFailure {
  const command = field(error, "command");
  const responseCode = field(error, "responseCode");
  const response = field(error, "response");
  const code = field(error, "code");
  const status =
    typeof response === "string"
      ? (/\b[245]\.\d{1,3}\.\d{1,3}\b/.exec(response)?.[0] ?? null)
      : null;
  const answered = typeof responseCode === "number" && responseCode >= 400 && responseCode < 600;
  // The mailer labels every lost connection CONN, whether it was lost before
  // or during the message; only the progress of the session tells them apart.
  const beforeMessage = code === "EAUTH" || (command === "CONN" && !dataSent);
  return {
    outcome: answered || beforeMessage ? "transport_rejected" : "transport_acceptance_unknown",
    command: typeof command === "string" ? command : null,
    responseCode: typeof responseCode === "number" ? responseCode : null,
    status,
  };
}
// Notes whether the DATA command was sent, from the mailer's command log. Pass
// it as the mailer's logger together with the transaction log option.
export function smtpProgress() {
  const progress = {
    dataSent: false,
    logger: {
      trace: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
      debug: (entry: unknown, message: unknown) => {
        const tnx = (entry as { tnx?: unknown } | null)?.tnx;
        if (tnx === "client" && typeof message === "string" && /^(C: )?DATA$/.test(message))
          progress.dataSent = true;
      },
    },
  };
  return progress;
}
