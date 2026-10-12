// Classifies a failed SMTP submission. A reply from the server that is not a
// success means the server did not take responsibility for the message, so
// it was not sent; the same holds for a failed connection or login. Anything
// else, such as a timeout or a dropped connection while the message was in
// flight, leaves acceptance unknown and must not be retried automatically.
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
export function classifySmtpFailure(error: unknown): SmtpFailure {
  const command = field(error, "command");
  const responseCode = field(error, "responseCode");
  const response = field(error, "response");
  const code = field(error, "code");
  const status =
    typeof response === "string"
      ? (/\b[245]\.\d{1,3}\.\d{1,3}\b/.exec(response)?.[0] ?? null)
      : null;
  const answered = typeof responseCode === "number" && responseCode >= 400 && responseCode < 600;
  const beforeMessage = code === "EAUTH" || command === "CONN";
  return {
    outcome: answered || beforeMessage ? "transport_rejected" : "transport_acceptance_unknown",
    command: typeof command === "string" ? command : null,
    responseCode: typeof responseCode === "number" ? responseCode : null,
    status,
  };
}
