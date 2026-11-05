// Cloudflare Email Worker for aidesk. Email Routing hands it every message for the addresses routed to it.
//
// 1. If the address has a route (secret AIDESK_ROUTES) and there is a way to reach aidesk (the VPC binding AIDESK, or the
//    address AIDESK_URL), the message is posted to the endpoint of the connection: POST /api/inbound/<connection>.
//    The answer is taken as delivered on any 2xx.
// 2. Otherwise, and on any failure of the first (no answer, a refusal, a timeout), the message is stored unchanged in R2
//    under inbound/<recipient>/<receipt time>-<random>.eml, where aidesk collects it. A message waits there while aidesk
//    is unreachable.
// 3. If neither works the worker throws, and Email Routing treats the message as not delivered.
//
// Both ways carry the same delivery id (header X-Aidesk-Delivery-Id, and the metadata `delivery` of the object), so a
// message that aidesk took but whose answer was lost, and that was then also left in the bucket, is taken once.
// Nothing is parsed or answered here. The types below are the subset of the Workers runtime this file uses.
interface MailBucket {
  put(
    key: string,
    value: ArrayBuffer,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
    },
  ): Promise<unknown>;
}
interface Reachable {
  fetch(input: string, init: RequestInit): Promise<Response>;
}
interface IncomingMail {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  forward(recipient: string): Promise<void>;
}
export interface Env {
  // The bucket of the fallback; without it a failure of the first way is a failure of the worker.
  MAIL?: MailBucket;
  // A VPC service (Workers VPC) that reaches aidesk through a tunnel, without a public name.
  AIDESK?: Reachable;
  // The address of aidesk when it is reached by name (https://desk.example.org); used when there is no VPC binding.
  AIDESK_URL?: string;
  // JSON, a secret: { "<recipient>": { "connection": "<id>", "token": "<token>" } }.
  AIDESK_ROUTES?: string;
  // A verified destination address of the account that also gets a copy of every message (optional).
  COPY_TO?: string;
  // Seconds to wait for aidesk before the bucket is used.
  AIDESK_TIMEOUT_SECONDS?: string;
}
interface Route {
  connection: string;
  token: string;
}
function routeOf(env: Env, recipient: string): Route | null {
  if (!env.AIDESK_ROUTES) return null;
  try {
    const routes = JSON.parse(env.AIDESK_ROUTES) as Record<string, Route>;
    const found = routes[recipient.toLowerCase()];
    return found && typeof found.connection === "string" && typeof found.token === "string"
      ? found
      : null;
  } catch {
    return null;
  }
}
// Posts the message to the endpoint; true when aidesk took it.
async function post(
  env: Env,
  route: Route,
  recipient: string,
  delivery: string,
  raw: ArrayBuffer,
): Promise<boolean> {
  const base = env.AIDESK_URL?.replace(/\/+$/, "");
  const target =
    env.AIDESK ?? (base ? { fetch: (url: string, init: RequestInit) => fetch(url, init) } : null);
  if (!target) return false;
  // A VPC service routes to its own host; the path is what counts, the host only fills the Host header.
  const url = `${base ?? "http://aidesk"}/api/inbound/${encodeURIComponent(route.connection)}`;
  const seconds = Number(env.AIDESK_TIMEOUT_SECONDS);
  try {
    const response = await target.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${route.token}`,
        "content-type": "message/rfc822",
        "x-aidesk-recipient": recipient,
        "x-aidesk-delivery-id": delivery,
      },
      body: raw,
      signal: AbortSignal.timeout((Number.isFinite(seconds) && seconds > 0 ? seconds : 20) * 1000),
    });
    // The body is read to its end so that the connection is free; it holds no secret.
    await response.arrayBuffer().catch(() => undefined);
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}
export default {
  async email(message: IncomingMail, env: Env): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    const recipient = message.to.toLowerCase();
    const delivery = crypto.randomUUID();
    const route = routeOf(env, recipient);
    let delivered = route ? await post(env, route, recipient, delivery, raw) : false;
    if (!delivered && env.MAIL) {
      const key = `inbound/${recipient}/${new Date().toISOString()}-${crypto.randomUUID()}.eml`;
      await env.MAIL.put(key, raw, {
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata: { from: message.from, to: message.to, delivery },
      });
      delivered = true;
    }
    if (!delivered) throw new Error("not_delivered");
    // A copy is best effort: the message is delivered, so a failure here is not one of the worker.
    if (env.COPY_TO) await message.forward(env.COPY_TO).catch(() => undefined);
  },
};
