// Cloudflare Email Worker for aidesk. Email Routing hands it every message
// for the addresses routed to it; it stores the message unchanged in R2 under
// inbound/<recipient>/<receipt time>-<random>.eml, where aidesk collects it.
// Nothing is parsed, answered or forwarded here.
//
// A failed write throws instead of being swallowed. The documentation does
// not say which SMTP reply Email Routing gives the sender in that case. The
// types below are the subset of the Workers runtime this file uses.
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
interface IncomingMail {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
}
interface Env {
  MAIL: MailBucket;
}
export default {
  async email(message: IncomingMail, env: Env): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    const key = `inbound/${message.to.toLowerCase()}/${new Date().toISOString()}-${crypto.randomUUID()}.eml`;
    await env.MAIL.put(key, raw, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { from: message.from, to: message.to },
    });
  },
};
