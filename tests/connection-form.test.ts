import { describe, expect, it } from "vitest";
import { definitions, toConfig, toValues } from "../src/components/connection-form";
import { connectionTypes, parseConnectionCreate, typeKey } from "../src/domain/connections";
// The form of a connection builds the document that the API checks: for every kind that the product
// has, what the form makes of its default values is a definition that the API accepts, and what the
// API stores is what the form shows again.
const secretOf = (key: string): Record<string, string> =>
  Object.fromEntries(
    (definitions.find((entry) => entry.key === key)?.secret ?? []).map((field) => [
      field.name,
      "x",
    ]),
  );
const filled: Record<string, Record<string, string>> = {
  "imap:inbound": { host: "mail.example.com", user: "support@example.com" },
  "cloudflare:inbound": {
    endpoint: "https://r2.example.com",
    bucket: "mail",
    address: "support@example.com",
  },
  "smtp:outbound": {
    host: "smtp.example.com",
    from: "support@example.com",
    replyTo: "support@example.com",
  },
  "cloudflare:outbound": {
    accountId: "a".repeat(32),
    from: "support@example.com",
    replyTo: "support@example.com",
  },
  "anthropic:ai": {},
  "openai:ai": {},
  "google:ai": {},
  "github:knowledge": { repositories: "acme/app\n\n  acme/docs  \n" },
  "docs:knowledge": {
    pages: "Guide | https://docs.example.com/guide\nhttps://docs.example.com/plain",
  },
  "context:knowledge": { endpoint: "https://crm.example.com/customers" },
};
describe("the form of a connection", () => {
  it("has a form for every kind of connection that the product has, and no other", () => {
    expect(definitions.map((entry) => entry.key).sort()).toEqual(
      Object.keys(connectionTypes).sort(),
    );
    for (const entry of definitions) expect(typeKey(entry.kind, entry.direction)).toBe(entry.key);
  });
  it("makes a definition that the API accepts from its default values and the fields to fill", () => {
    for (const entry of definitions) {
      const values = { ...toValues(entry, {}), ...filled[entry.key] };
      const body = {
        kind: entry.kind,
        direction: entry.direction,
        name: "Connection",
        config: toConfig(entry, values),
        ...(Object.keys(secretOf(entry.key)).length > 0 &&
        entry.secret.some((field) => !field.optional)
          ? { secret: secretOf(entry.key) }
          : {}),
      };
      expect(() => parseConnectionCreate(body), entry.key).not.toThrow();
    }
  });
  it("turns lines into lists and pages into title and address, and leaves out optional fields that are empty", () => {
    const github = definitions.find((entry) => entry.key === "github:knowledge");
    const docs = definitions.find((entry) => entry.key === "docs:knowledge");
    const imap = definitions.find((entry) => entry.key === "imap:inbound");
    if (!github || !docs || !imap) throw new Error("missing");
    expect(
      toConfig(github, { repositories: "acme/app\n\n  acme/docs  \n", endpoint: " " }),
    ).toEqual({
      repositories: ["acme/app", "acme/docs"],
    });
    expect(
      toConfig(docs, { pages: "Guide | https://a.example.com/x | y\nhttps://b.example.com/" }),
    ).toEqual({
      pages: [
        { title: "Guide", url: "https://a.example.com/x | y" },
        { title: "https://b.example.com/", url: "https://b.example.com/" },
      ],
    });
    expect(
      toConfig(imap, {
        host: " h ",
        port: "143",
        secure: "false",
        user: "u",
        mailbox: "",
        junkMailbox: "",
      }),
    ).toEqual({ host: "h", port: 143, secure: false, user: "u" });
  });
  it("shows again what was stored, with the defaults where nothing was", () => {
    const docs = definitions.find((entry) => entry.key === "docs:knowledge");
    const smtp = definitions.find((entry) => entry.key === "smtp:outbound");
    const github = definitions.find((entry) => entry.key === "github:knowledge");
    if (!docs || !smtp || !github) throw new Error("missing");
    expect(toValues(smtp, {})).toMatchObject({ port: "587", secure: "false", host: "" });
    expect(toValues(smtp, { port: 465, secure: true, host: "smtp.example.com" })).toMatchObject({
      port: "465",
      secure: "true",
      host: "smtp.example.com",
    });
    const stored = { pages: [{ title: "Guide", url: "https://docs.example.com/guide" }] };
    expect(toValues(docs, stored).pages).toBe("Guide | https://docs.example.com/guide");
    expect(toConfig(docs, toValues(docs, stored))).toEqual(stored);
    const repos = {
      repositories: ["acme/app", "acme/docs"],
      endpoint: "https://ghe.example.com/api",
    };
    expect(toConfig(github, toValues(github, repos))).toEqual(repos);
    expect(toValues(github, {})).toMatchObject({ repositories: "" });
  });
});
