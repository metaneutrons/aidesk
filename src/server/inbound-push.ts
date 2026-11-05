import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { connections } from "./db/schema";
import { pushInboundConfig, pushInboundSecret } from "../domain/connections";
import { DomainError } from "./errors";
import { acceptInbound, maxRawBytes } from "./inbound";
import { unsealSecret } from "./secrets";
// Mail that is handed over through POST /api/inbound/<connection>: the Email Worker of Cloudflare, or any
// program that holds the token of the connection. The body is the message as it came (RFC 822, with its
// attachments); the envelope recipient and an id of the delivery are in headers. The id makes a repeat
// harmless: the same id is the same mail, whether it arrives twice here or once here and once through
// the bucket of the Email Worker.
//
// Every refusal before the body is read answers alike (401) and costs no more than a lookup, so a
// request without the token learns nothing about which connections exist and cannot make the product
// read a large body.
export interface PushRequest {
  connectionId: string;
  authorization: string | null;
  recipient: string | null;
  deliveryId: string | null;
  sourceAddress: string | null;
  // Reads the body; throws "inbound_size" when it is larger than the limit.
  readBody: (limit: number) => Promise<Buffer>;
}
export interface PushResponse {
  status: number;
  body: Record<string, unknown>;
}
const deliveryId = z.string().regex(/^[A-Za-z0-9._-]{8,100}$/);
const uuid = z.uuid();
const refused = (): PushResponse => ({ status: 401, body: { error: "unauthenticated" } });
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
// A source address is allowed when the list is empty or one of its ranges holds it. An address that
// cannot be read is not allowed. A mapped IPv4 address (::ffff:192.0.2.1) counts as the IPv4 one.
export function sourceAllowed(ranges: string[], address: string | null): boolean {
  if (ranges.length === 0) return true;
  const plain = address?.replace(/^::ffff:/i, "") ?? "";
  const version = isIP(plain);
  if (version === 0) return false;
  const list = new BlockList();
  try {
    for (const range of ranges) {
      const [base = "", prefix = ""] = range.split("/");
      const family = isIP(base);
      if (family === 0) return false;
      list.addSubnet(base, Number(prefix), family === 4 ? "ipv4" : "ipv6");
    }
  } catch {
    return false;
  }
  return list.check(plain, version === 4 ? "ipv4" : "ipv6");
}
// The address a proxy in front of the product saw: the last entry of X-Forwarded-For is the one the
// nearest proxy added, the ones before it were claimed by the client.
export function forwardedAddress(header: string | null): string | null {
  const last = header?.split(",").at(-1)?.trim();
  return last === undefined || last === "" ? null : last;
}
// A token for a connection of this kind.
export function newPushToken(): string {
  return randomBytes(32).toString("hex");
}
export async function receivePush(request: PushRequest): Promise<PushResponse> {
  const id = uuid.safeParse(request.connectionId);
  const [row] = id.success
    ? await db()
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.id, id.data),
            eq(connections.kind, "push"),
            eq(connections.direction, "inbound"),
          ),
        )
    : [];
  const given = digest(request.authorization?.replace(/^Bearer /, "") ?? "");
  // Without a connection the comparison still runs, against a value nobody knows.
  let wanted: Buffer = digest(randomBytes(32).toString("hex"));
  let config: z.infer<typeof pushInboundConfig> | null = null;
  if (row?.secretCiphertext && row.status === "ready") {
    const secret = pushInboundSecret.safeParse(JSON.parse(unsealSecret(row.secretCiphertext)));
    const parsed = pushInboundConfig.safeParse(row.config);
    if (secret.success && parsed.success) {
      wanted = digest(secret.data.token);
      config = parsed.data;
    }
  }
  const known = timingSafeEqual(given, wanted) && config !== null;
  if (!row || !config || !known || !request.authorization?.startsWith("Bearer ")) return refused();
  const log = (event: string, detail: Record<string, unknown> = {}) => {
    console.log(JSON.stringify({ event, connectionId: row.id, ...detail }));
  };
  if (!sourceAllowed(config.allowedSources, request.sourceAddress)) {
    log("push.refused", { reason: "source" });
    return refused();
  }
  const delivery = deliveryId.safeParse(request.deliveryId);
  const recipient = z.email().safeParse(request.recipient?.trim());
  if (!delivery.success || !recipient.success)
    return { status: 400, body: { error: "invalid_request" } };
  if (!config.addresses.some((address) => address.toLowerCase() === recipient.data.toLowerCase())) {
    log("push.refused", { reason: "recipient" });
    return { status: 422, body: { error: "recipient_not_accepted" } };
  }
  let raw: Buffer;
  try {
    raw = await request.readBody(maxRawBytes);
  } catch {
    return { status: 413, body: { error: "too_large" } };
  }
  try {
    const accepted = await acceptInbound({
      projectId: row.projectId,
      connectionId: row.id,
      externalKey: `delivery:${delivery.data}`,
      raw,
      origin: { transport: "push", recipient: recipient.data.toLowerCase() },
    });
    log("push.accepted", { duplicate: accepted.duplicate, bytes: raw.length });
    return {
      status: accepted.duplicate ? 200 : 202,
      body: { ingressId: accepted.ingressId, duplicate: accepted.duplicate },
    };
  } catch (error) {
    if (error instanceof DomainError && error.code === "project_archived")
      return { status: 409, body: { error: "project_archived" } };
    if (error instanceof Error && error.message === "inbound_size")
      return { status: 413, body: { error: "too_large" } };
    log("push.failed", { code: error instanceof Error ? error.message.slice(0, 64) : "failed" });
    return { status: 503, body: { error: "unavailable" } };
  }
}
