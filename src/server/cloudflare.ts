import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { connections } from "./db/schema";
import { unseal } from "./crypto";
import { env } from "./env";
import { acceptInbound } from "./inbound";
import { isMessageId } from "../domain/threading";
// Cloudflare Email Routing hands each message to the Email Worker in
// cloudflare/mail-ingest, which stores it unchanged in an R2 bucket under
// inbound/<recipient>/. aidesk collects the objects through the S3 API, so a
// message waits in the bucket while aidesk is unreachable.
const inboundConfig = z.object({
  endpoint: z.url(),
  bucket: z.string().min(1),
  address: z.email(),
  region: z.string().min(1).default("auto"),
  developmentOnly: z.boolean().default(false),
});
const inboundSecret = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
});
export function inboundPrefix(address: string): string {
  return `inbound/${address.toLowerCase()}/`;
}
export interface CloudflarePollResult {
  accepted: number;
  duplicates: number;
}
const batchSize = 50;
// An object is deleted only after the inbound core has committed it. A crash
// in between leaves the object in place; the next poll finds the same
// external key and only deletes it.
export async function pollCloudflareConnection(
  connectionId: string,
): Promise<CloudflarePollResult> {
  const [connection] = await db()
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.kind, "cloudflare"),
        eq(connections.direction, "inbound"),
      ),
    );
  if (!connection) throw new Error("cloudflare_connection_missing");
  const config = inboundConfig.parse(connection.config);
  const development =
    process.env.NODE_ENV === "development" && process.env.DEV_BOOTSTRAP === "true";
  if (config.developmentOnly && !development) throw new Error("development_connection_not_allowed");
  if (!config.developmentOnly && new URL(config.endpoint).protocol !== "https:")
    throw new Error("cloudflare_tls_required");
  if (!connection.secretCiphertext) throw new Error("cloudflare_secret_missing");
  const secret = inboundSecret.parse(
    JSON.parse(unseal(connection.secretCiphertext, env().ENCRYPTION_KEY)),
  );
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: secret,
  });
  const result: CloudflarePollResult = { accepted: 0, duplicates: 0 };
  const listed = await client.send(
    new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: inboundPrefix(config.address),
      MaxKeys: batchSize,
    }),
  );
  // Keys start with the receipt time, so the listing order is arrival order.
  for (const object of listed.Contents ?? []) {
    if (!object.Key) continue;
    const body = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: object.Key }),
    );
    if (!body.Body) throw new Error("cloudflare_object_empty");
    const accepted = await acceptInbound({
      projectId: connection.projectId,
      connectionId: connection.id,
      externalKey: `cloudflare:${connection.id}:${object.Key}`,
      raw: Buffer.from(await body.Body.transformToByteArray()),
    });
    if (accepted.duplicate) result.duplicates += 1;
    else result.accepted += 1;
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: object.Key }));
  }
  return result;
}
const outboundConfig = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  from: z.email(),
  replyTo: z.email(),
});
const outboundSecret = z.object({ apiToken: z.string().min(1) });
export type CloudflareOutboundConfig = z.infer<typeof outboundConfig>;
export function parseCloudflareOutbound(config: unknown, secretCiphertext: string | null) {
  if (!secretCiphertext) throw new Error("cloudflare_secret_missing");
  return {
    config: outboundConfig.parse(config),
    secret: outboundSecret.parse(JSON.parse(unseal(secretCiphertext, env().ENCRYPTION_KEY))),
  };
}
export interface OutgoingMail {
  fromName: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  ticketId: string;
  // An acknowledgement or other automatic mail (RFC 3834).
  automatic?: boolean;
}
const sendResponse = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number(), message: z.string() })).default([]),
  result: z
    .object({
      delivered: z.array(z.string()).default([]),
      queued: z.array(z.string()).default([]),
      permanent_bounces: z.array(z.string()).default([]),
      message_id: z.string().optional(),
    })
    .nullable()
    .default(null),
});
// Sends one reply through Cloudflare Email Sending. Cloudflare assigns the
// Message-ID itself; it is returned so later replies can reference it.
//
// "transport_rejected" means Cloudflare refused the message before accepting
// it, so it was not sent. Every other failure, including timeouts and server
// errors, leaves acceptance unknown and must not be retried automatically.
export async function sendViaCloudflare(
  config: CloudflareOutboundConfig,
  secret: { apiToken: string },
  mail: OutgoingMail,
): Promise<{ messageId: string | null }> {
  const headers: Record<string, string> = { "X-Aidesk-Ticket": mail.ticketId };
  if (mail.automatic) {
    headers["Auto-Submitted"] = "auto-replied";
    headers["X-Auto-Response-Suppress"] = "All";
  }
  if (isMessageId(mail.inReplyTo)) headers["In-Reply-To"] = mail.inReplyTo;
  if (mail.references?.split(" ").every(isMessageId)) headers.References = mail.references;
  let response: Response;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: { address: config.from, name: mail.fromName },
          reply_to: config.replyTo,
          to: mail.to,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          headers,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new Error("transport_acceptance_unknown");
  }
  if (response.status >= 500) throw new Error("transport_acceptance_unknown");
  const parsed = sendResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("transport_acceptance_unknown");
  if (!response.ok || !parsed.data.success) {
    console.log(
      JSON.stringify({
        event: "cloudflare.send_rejected",
        status: response.status,
        codes: parsed.data.errors.map((error) => error.code),
      }),
    );
    throw new Error("transport_rejected");
  }
  const result = parsed.data.result;
  const recipient = mail.to.toLowerCase();
  const accepted = [...(result?.delivered ?? []), ...(result?.queued ?? [])].map((address) =>
    address.toLowerCase(),
  );
  if (result?.permanent_bounces.some((address) => address.toLowerCase() === recipient))
    throw new Error("transport_rejected");
  if (!accepted.includes(recipient)) throw new Error("transport_acceptance_unknown");
  const messageId = result?.message_id;
  return { messageId: isMessageId(messageId) ? messageId : null };
}
