import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseMailjetOutbound,
  probeMailjet,
  sendViaMailjet,
  type MailjetMail,
} from "../src/server/mailjet";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
const config = { from: "support@example.test", replyTo: "reply@example.test" };
const secret = { apiKey: "key-value", secretKey: "secret-value" };
const mail: MailjetMail = {
  fromName: "Orbit",
  to: "Customer@Example.test",
  subject: "Re: Export",
  html: "<p>Answer</p>",
  text: "Answer",
  inReplyTo: "<a@example.test>",
  references: "<a@example.test> <b@example.test>",
  ticketId: "ticket-1",
  localId: "message-1",
};
// The body of an answer as Mailjet sends it: ids come as numbers that a JSON number cannot hold.
const accepted = (id = "1152921512359371122") =>
  `{"Messages":[{"Status":"success","CustomID":"message-1","To":[{"Email":"customer@example.test","MessageUUID":"u-1","MessageID":${id},"MessageHref":"https://api.mailjet.com/v3/REST/message/${id}"}],"Cc":[],"Bcc":[]}]}`;
function reply(status: number, body: string) {
  const fetch = vi.fn(() => Promise.resolve(new Response(body, { status })));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const body = (fetch: ReturnType<typeof reply>) => {
  const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as {
    SandboxMode?: boolean;
    Messages: Record<string, unknown>[];
  };
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("Mailjet outbound", () => {
  it("sends one message with its threading headers and keeps the id of the mail", async () => {
    const fetch = reply(200, accepted());
    expect(await sendViaMailjet(config, secret, mail)).toEqual({
      messageId: "<message-1@example.test>",
      providerId: "1152921512359371122",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.mailjet.com/v3.1/send");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("key-value:secret-value").toString("base64")}`,
    );
    expect(body(fetch)).toEqual({
      Messages: [
        {
          From: { Email: "support@example.test", Name: "Orbit" },
          ReplyTo: { Email: "reply@example.test" },
          To: [{ Email: "Customer@Example.test" }],
          Subject: "Re: Export",
          HTMLPart: "<p>Answer</p>",
          TextPart: "Answer",
          Headers: {
            "Message-ID": "<message-1@example.test>",
            "X-Aidesk-Ticket": "ticket-1",
            "In-Reply-To": "<a@example.test>",
            References: "<a@example.test> <b@example.test>",
          },
          CustomID: "message-1",
          TrackOpens: "disabled",
          TrackClicks: "disabled",
        },
      ],
    });
  });
  it("reads an id that is larger than a JSON number holds without a change", async () => {
    reply(201, accepted("9007199254740993"));
    expect((await sendViaMailjet(config, secret, mail)).providerId).toBe("9007199254740993");
  });
  it("marks automatic mail and leaves out a thread that is not made of message ids", async () => {
    const fetch = reply(200, accepted());
    await sendViaMailjet(config, secret, {
      ...mail,
      inReplyTo: "nothing",
      references: "not a message id",
      automatic: true,
    });
    expect((body(fetch).Messages[0] as { Headers: unknown }).Headers).toEqual({
      "Message-ID": "<message-1@example.test>",
      "X-Aidesk-Ticket": "ticket-1",
      "Auto-Submitted": "auto-replied",
      "X-Auto-Response-Suppress": "All",
    });
  });
  it("tells a refusal apart from an unknown outcome", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const status of [400, 401, 403, 429]) {
      reply(
        status,
        '{"ErrorCode":"send-0011","ErrorMessage":"customer@example.test is not allowed","StatusCode":400}',
      );
      await expect(sendViaMailjet(config, secret, mail)).rejects.toThrow("transport_rejected");
    }
    // The message was refused although the request was answered with success.
    reply(
      200,
      '{"Messages":[{"Status":"error","Errors":[{"ErrorCode":"mj-0013","StatusCode":400,"ErrorMessage":"customer@example.test"}]}]}',
    );
    await expect(sendViaMailjet(config, secret, mail)).rejects.toThrow("transport_rejected");
    // The log names codes and no address or text of an error.
    const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("send-0011");
    expect(logged).toContain("mj-0013");
    expect(logged).not.toContain("customer@example.test");
    for (const [status, text] of [
      [500, "{}"],
      [502, "<html>bad gateway</html>"],
      [302, ""],
      [200, "not json"],
      [200, '{"Messages":[]}'],
      [200, '{"Messages":[{"Status":"success","To":[{"Email":"other@example.test"}]}]}'],
      [200, '{"Messages":[{"Status":"queued","To":[{"Email":"customer@example.test"}]}]}'],
    ] as const) {
      reply(status, text);
      await expect(sendViaMailjet(config, secret, mail)).rejects.toThrow(
        "transport_acceptance_unknown",
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("timeout"))),
    );
    await expect(sendViaMailjet(config, secret, mail)).rejects.toThrow(
      "transport_acceptance_unknown",
    );
  });
  it("reads its sealed configuration", () => {
    expect(
      parseMailjetOutbound(config, seal(JSON.stringify(secret), env().ENCRYPTION_KEY)),
    ).toEqual({ config, secret });
    expect(() => parseMailjetOutbound(config, null)).toThrow("mailjet_secret_missing");
  });
});
describe("Mailjet probe", () => {
  it("runs the checks of a send in the sandbox mode and delivers nothing", async () => {
    const fetch = reply(
      200,
      '{"Messages":[{"Status":"success","To":[{"Email":"support@example.test"}]}]}',
    );
    await probeMailjet(config, secret, 1000);
    const sent = body(fetch);
    expect(sent.SandboxMode).toBe(true);
    expect(sent.Messages[0]).toMatchObject({
      To: [{ Email: "support@example.test" }],
      Headers: { "Message-ID": "<connection-test@example.test>" },
    });
  });
  it("reports the status that a failure carries, and an authentication failure as such", async () => {
    reply(401, '{"ErrorCode":"mj-0015","StatusCode":401}');
    await expect(probeMailjet(config, secret, 1000)).rejects.toMatchObject({
      authenticationFailed: true,
    });
    reply(403, '{"ErrorCode":"send-0007","StatusCode":403}');
    await expect(probeMailjet(config, secret, 1000)).rejects.toMatchObject({ providerStatus: 403 });
    reply(
      200,
      '{"Messages":[{"Status":"error","Errors":[{"ErrorCode":"send-0011","StatusCode":400}]}]}',
    );
    await expect(probeMailjet(config, secret, 1000)).rejects.toMatchObject({ providerStatus: 400 });
    reply(500, "<html></html>");
    await expect(probeMailjet(config, secret, 1000)).rejects.toMatchObject({ providerStatus: 500 });
  });
});
