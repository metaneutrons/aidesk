import { describe, expect, it } from "vitest";
import {
  channelBody,
  channelKindOf,
  type ChannelKind,
  type ChannelValues,
} from "../src/domain/webhook-channel";
import {
  channelEvents,
  channelFormats,
  eventsOfChannel,
  webhookCreate,
  type ChannelFormat,
} from "../src/domain/webhooks";
// A signing secret of the right length, made when the test runs.
const signing = `whsec_${"a".repeat(24)}`;
const url = "https://desk.example.test/?ticket=0f4c6e7a-0000-4000-8000-000000000001";
const values = (extra: Partial<ChannelValues> = {}): ChannelValues => ({
  kind: "created",
  language: "en",
  project: "Support",
  number: 42,
  subject: null,
  url,
  ...extra,
});
const text = (value: unknown): string => JSON.stringify(value);
describe("the message of a channel", () => {
  it("names the kind, the number and the link and not the subject, in every format", () => {
    for (const format of channelFormats) {
      const body = text(channelBody(format, values()));
      expect(body, format).toContain("New ticket");
      expect(body, format).toContain("#42");
      expect(body, format).toContain(url);
      expect(body, format).toContain("Support");
    }
  });
  it("writes the body that the messenger documents", () => {
    const withSubject = values({ subject: "Printer broken" });
    expect(channelBody("slack", withSubject)).toEqual({
      text: `*New ticket* · Support\n#42 Printer broken\n<${url}|Open the ticket>`,
    });
    expect(channelBody("mattermost", withSubject)).toEqual({
      text: `**New ticket** · Support\n#42 Printer broken\n[Open the ticket](${url})`,
    });
    expect(channelBody("discord", withSubject)).toEqual({
      content: `**New ticket** · Support\n#42 Printer broken\n[Open the ticket](${url})`,
      allowed_mentions: { parse: [] },
    });
    expect(channelBody("rocketchat", withSubject)).toEqual({
      text: "New ticket · Support",
      attachments: [{ title: "#42 Printer broken", title_link: url }],
    });
    expect(channelBody("apprise", withSubject)).toEqual({
      title: "New ticket · Support",
      body: `#42 Printer broken\n\n[Open the ticket](${url})`,
      type: "info",
      format: "markdown",
    });
    const card = channelBody("teams", withSubject) as {
      type: string;
      attachments: { contentType: string; content: Record<string, unknown> }[];
    };
    expect(card.type).toBe("message");
    expect(card.attachments).toHaveLength(1);
    expect(card.attachments[0]?.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.attachments[0]?.content).toMatchObject({
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.2",
    });
    expect(text(card)).toContain("Printer broken");
  });
  it("is written in German for a project in German", () => {
    for (const format of channelFormats)
      expect(text(channelBody(format, values({ language: "de" }))), format).toContain(
        "Neues Ticket",
      );
    expect(text(channelBody("slack", values({ language: "de" })))).toContain("Ticket öffnen");
  });
  it("lets the subject neither format the message, nor hide a link, nor call anybody", () => {
    const subject =
      "@channel @here <!channel> <https://evil.example|pay now> **bold** [x](https://evil.example)";
    for (const format of channelFormats) {
      const body = text(channelBody(format, values({ subject })));
      // Nothing that calls a person or a channel is left: every @ is followed by a zero-width space.
      expect(body.match(/@(?!\u200b)/g), `${format} mentions`).toBeNull();
      // No link with a text of its own is made of the subject, in Markdown or in the form of Slack.
      // Slack does not read Markdown, so the text stays as it is there.
      if (format !== "slack")
        expect(body, `${format} masked link`).not.toMatch(/(?<!\\)\]\(https:\/\/evil/);
      if (format === "slack") expect(body, "slack link").not.toContain("<https://evil");
    }
    // Slack reads `&`, `<` and `>` as the start of a link or a mention and takes them as entities.
    const slack = channelBody("slack", values({ subject })) as { text: string };
    expect(slack.text).toContain("&lt;!channel&gt;");
    expect(slack.text).toContain("&lt;https://evil.example|pay now&gt;");
    expect(slack.text).not.toContain("<!channel>");
    // The formats that read Markdown get its marks as text.
    const mattermost = channelBody("mattermost", values({ subject })) as { text: string };
    const discord = channelBody("discord", values({ subject })) as { content: string };
    for (const written of [mattermost.text, discord.content]) {
      expect(written).toContain("\\*\\*bold\\*\\*");
      expect(written).toContain("\\[x\\]\\(https://evil\\.example\\)");
    }
  });
  it("cuts a long subject and removes line breaks and control characters", () => {
    const body = channelBody(
      "slack",
      values({ subject: `${"x".repeat(400)}\nsecond line\u0007` }),
    ) as { text: string };
    expect(body.text.split("\n")).toHaveLength(3);
    expect(body.text).not.toContain("\u0007");
    expect(body.text.length).toBeLessThan(400);
  });
  it("is a plain test message without a ticket", () => {
    for (const format of channelFormats) {
      const body = text(
        channelBody(format, values({ kind: "ping", number: null, subject: null, url: null })),
      );
      expect(body, format).toContain("Test message");
      expect(body, format).not.toContain("#");
      expect(body, format).not.toContain("?ticket=");
    }
  });
  it("marks an overdue ticket as a warning and a resolved one as a success for Apprise", () => {
    expect(channelBody("apprise", values({ kind: "overdue" }))).toMatchObject({ type: "warning" });
    expect(channelBody("apprise", values({ kind: "resolved" }))).toMatchObject({ type: "success" });
  });
});
describe("the kind of message for an event", () => {
  it("is known for the events of a channel and for a test, and for no other", () => {
    const kinds: [string, Record<string, unknown>, ChannelKind][] = [
      ["ping", {}, "ping"],
      ["ticket.created", {}, "created"],
      ["ticket.assigned", {}, "assigned"],
      ["ticket.overdue", {}, "overdue"],
      ["draft.created", {}, "draft"],
      ["ticket.status_changed", { from: "open", to: "resolved" }, "resolved"],
      ["ticket.status_changed", { from: "resolved", to: "open" }, "reopened"],
      ["ticket.status_changed", { from: "open", to: "waiting" }, "changed"],
    ];
    for (const [type, data, kind] of kinds) expect(channelKindOf(type, data), type).toBe(kind);
    for (const type of ["message.received", "ticket.triaged", "ticket.warning", "ai.budget_low"])
      expect(channelKindOf(type, {}), type).toBeNull();
  });
});
describe("defining a webhook", () => {
  const base = { name: "Channel", url: "https://hooks.example.test/services/KEY" };
  it("needs a signing secret for the format aidesk and takes none for a channel", () => {
    expect(webhookCreate.safeParse({ ...base, events: ["ticket.created"] }).success).toBe(false);
    expect(
      webhookCreate.safeParse({
        ...base,
        events: ["ticket.created"],
        secret: signing,
      }).success,
    ).toBe(true);
    for (const format of channelFormats as readonly ChannelFormat[]) {
      expect(webhookCreate.safeParse({ ...base, format, events: ["ticket.created"] }).success).toBe(
        true,
      );
      expect(
        webhookCreate.safeParse({
          ...base,
          format,
          events: ["ticket.created"],
          secret: signing,
        }).success,
      ).toBe(false);
    }
  });
  it("limits a channel to the events that tell people about a ticket", () => {
    expect(eventsOfChannel(channelEvents)).toBe(true);
    expect(eventsOfChannel(["ticket.created", "ai.budget_low"])).toBe(false);
    expect(
      webhookCreate.safeParse({ ...base, format: "slack", events: ["message.received"] }).success,
    ).toBe(false);
  });
  it("lets only a channel name the subject, and has it off by default", () => {
    const channel = webhookCreate.parse({ ...base, format: "slack", events: ["ticket.created"] });
    expect(channel.withSubject).toBe(false);
    expect(
      webhookCreate.safeParse({
        ...base,
        events: ["ticket.created"],
        secret: signing,
        withSubject: true,
      }).success,
    ).toBe(false);
  });
});
