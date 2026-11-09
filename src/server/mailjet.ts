import { z } from "zod";
import { mailjetOutboundConfig, mailjetOutboundSecret } from "../domain/connections";
import { isMessageId } from "../domain/threading";
import type { OutgoingMail } from "./cloudflare";
import { unsealSecret } from "./secrets";
// Replies that go out through the Send API of Mailjet (v3.1). The address is fixed, so a connection
// cannot point the credentials at another host.
const endpoint = "https://api.mailjet.com/v3.1/send";
export type MailjetOutboundConfig = z.infer<typeof mailjetOutboundConfig>;
export type MailjetSecret = z.infer<typeof mailjetOutboundSecret>;
export function parseMailjetOutbound(config: unknown, secretCiphertext: string | null) {
  if (!secretCiphertext) throw new Error("mailjet_secret_missing");
  return {
    config: mailjetOutboundConfig.parse(config),
    secret: mailjetOutboundSecret.parse(JSON.parse(unsealSecret(secretCiphertext))),
  };
}
// The local part of the Message-ID is the id of the message, so a reply of the customer that names it
// finds the ticket again. Mailjet returns only its own numeric id, which is not an RFC 5322 id.
export interface MailjetMail extends OutgoingMail {
  localId: string;
}
function messageIdOf(config: MailjetOutboundConfig, localId: string): string {
  return `<${localId}@${config.from.slice(config.from.lastIndexOf("@") + 1)}>`;
}
// One message in the request. Tracking is switched off for every mail: a link that Mailjet rewrites
// for click tracking would break the portal link of a ticket and tell a third party who opened it.
function requestBody(config: MailjetOutboundConfig, mail: MailjetMail, sandbox: boolean) {
  const headers: Record<string, string> = {
    "Message-ID": messageIdOf(config, mail.localId),
    "X-Aidesk-Ticket": mail.ticketId,
  };
  if (mail.automatic) {
    headers["Auto-Submitted"] = "auto-replied";
    headers["X-Auto-Response-Suppress"] = "All";
  }
  if (isMessageId(mail.inReplyTo)) headers["In-Reply-To"] = mail.inReplyTo;
  if (mail.references?.split(" ").every(isMessageId)) headers.References = mail.references;
  return JSON.stringify({
    ...(sandbox ? { SandboxMode: true } : {}),
    Messages: [
      {
        From: { Email: config.from, Name: mail.fromName },
        ReplyTo: { Email: config.replyTo },
        To: [{ Email: mail.to }],
        Subject: mail.subject,
        HTMLPart: mail.html,
        TextPart: mail.text,
        Headers: headers,
        CustomID: mail.localId,
        TrackOpens: "disabled",
        TrackClicks: "disabled",
      },
    ],
  });
}
const authorization = (secret: MailjetSecret) =>
  `Basic ${Buffer.from(`${secret.apiKey}:${secret.secretKey}`).toString("base64")}`;
// The numeric ids of Mailjet are larger than a JSON number holds exactly, so they are read as text.
const readable = (text: string) => text.replace(/("MessageID"\s*:\s*)(\d{15,})/g, '$1"$2"');
const sendResponse = z.object({
  Messages: z
    .array(
      z.object({
        Status: z.string(),
        Errors: z
          .array(z.object({ ErrorCode: z.string().optional(), StatusCode: z.number().optional() }))
          .default([]),
        To: z
          .array(
            z.object({
              Email: z.string(),
              MessageID: z.union([z.string(), z.number()]).optional(),
            }),
          )
          .default([]),
      }),
    )
    .min(1),
});
// The error codes of an answer (mj-0013, send-0007), which carry neither an address nor a credential.
function errorCodes(body: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === "ErrorCode" && typeof entry === "string" && /^[a-z]+-\d{4}$/.test(entry))
        found.push(entry);
      else visit(entry, depth + 1);
    }
  };
  visit(body, 0);
  return found.slice(0, 10);
}
function post(secret: MailjetSecret, body: string, timeoutMs: number) {
  return fetch(endpoint, {
    method: "POST",
    headers: { Authorization: authorization(secret), "Content-Type": "application/json" },
    body,
    // A redirect would take the credentials to another host.
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
}
// Sends one reply. "transport_rejected" means Mailjet refused the message before it accepted it, so it
// was not sent. A timeout, a server error and an answer that cannot be read leave the outcome unknown,
// and such a mail is never sent again automatically.
export async function sendViaMailjet(
  config: MailjetOutboundConfig,
  secret: MailjetSecret,
  mail: MailjetMail,
): Promise<{ messageId: string; providerId: string | null }> {
  let response: Response;
  let text: string;
  try {
    response = await post(secret, requestBody(config, mail, false), 30_000);
    text = await response.text();
  } catch {
    throw new Error("transport_acceptance_unknown");
  }
  let body: unknown;
  try {
    body = JSON.parse(readable(text));
  } catch {
    body = null;
  }
  if (response.status >= 400 && response.status < 500) {
    console.log(
      JSON.stringify({
        event: "mailjet.send_rejected",
        status: response.status,
        codes: errorCodes(body),
      }),
    );
    throw new Error("transport_rejected");
  }
  if (response.status < 200 || response.status >= 300)
    throw new Error("transport_acceptance_unknown");
  const parsed = sendResponse.safeParse(body);
  if (!parsed.success) throw new Error("transport_acceptance_unknown");
  const entry = parsed.data.Messages[0];
  if (!entry) throw new Error("transport_acceptance_unknown");
  if (entry.Status === "error") {
    console.log(JSON.stringify({ event: "mailjet.send_rejected", codes: errorCodes(body) }));
    throw new Error("transport_rejected");
  }
  const recipient = mail.to.toLowerCase();
  const accepted = entry.To.find((target) => target.Email.toLowerCase() === recipient);
  if (entry.Status !== "success" || !accepted) throw new Error("transport_acceptance_unknown");
  return {
    messageId: messageIdOf(config, mail.localId),
    providerId: accepted.MessageID === undefined ? null : String(accepted.MessageID),
  };
}
// Checks the credentials, the sender and the headers of a reply without a delivery: the sandbox mode of
// the Send API runs every check of a send and delivers nothing. A failure carries the status of the
// answer, as the checks of the other providers do.
export async function probeMailjet(
  config: MailjetOutboundConfig,
  secret: MailjetSecret,
  timeoutMs: number,
): Promise<void> {
  const probe: MailjetMail = {
    fromName: "aidesk",
    to: config.from,
    subject: "Connection test",
    html: "<p>Connection test</p>",
    text: "Connection test",
    inReplyTo: messageIdOf(config, "connection-test-parent"),
    ticketId: "connection-test",
    localId: "connection-test",
  };
  const response = await post(secret, requestBody(config, probe, true), timeoutMs);
  if (response.status === 401)
    throw Object.assign(new Error("auth"), { authenticationFailed: true });
  const body: unknown = await response.json().catch(() => null);
  const parsed = sendResponse.safeParse(body);
  if (response.ok && parsed.success && parsed.data.Messages[0]?.Status === "success") return;
  const refused = parsed.success ? parsed.data.Messages[0]?.Errors[0]?.StatusCode : undefined;
  throw Object.assign(new Error("provider"), {
    providerStatus: response.ok ? (refused ?? 400) : response.status,
  });
}
