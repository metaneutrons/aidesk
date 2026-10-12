import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { connections, ingress, jobs, messages, projects, tickets } from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import { initializeStorage } from "../src/server/storage";
import { decideLanguage, detectLanguage } from "../src/domain/language";
const german =
  "Hallo, ich habe seit gestern ein Problem mit der Anmeldung und kann mich nicht mehr einloggen. Bitte melden Sie sich, wenn Sie mehr Informationen brauchen.";
const english =
  "Hello, I have had a problem with the login since yesterday and I cannot sign in anymore. Please let me know if you need more information about this.";
describe("language detection", () => {
  it("names the language of ordinary sentences", () => {
    expect(detectLanguage(german)).toMatchObject({ language: "de", reason: "reliable" });
    expect(detectLanguage(english)).toMatchObject({ language: "en", reason: "reliable" });
  });
  it("leaves the language open for short, mixed or empty text", () => {
    expect(detectLanguage("Hello, thanks")).toMatchObject({ language: null, reason: "too_short" });
    expect(detectLanguage("")).toMatchObject({ language: null, reason: "too_short", words: 0 });
    // Equal parts of both languages are not decided.
    expect(detectLanguage(`${german} ${english}`)).toMatchObject({
      language: null,
      reason: "ambiguous",
    });
    // Many words but no function words of either language.
    expect(
      detectLanguage("Server Cluster Gateway Router Switch Proxy Cache Queue Worker Broker"),
    ).toMatchObject({ language: null, reason: "ambiguous" });
    // One or two function words are not enough.
    expect(
      detectLanguage("Server Cluster Gateway Router Switch the Proxy Cache and Queue Worker"),
    ).toMatchObject({ language: null, reason: "ambiguous" });
  });
  it("ignores quoted history, code and links", () => {
    const quoted = `${english}\n\n> ${german.split(". ").join("\n> ")}`;
    expect(detectLanguage(quoted).language).toBe("en");
    const code = "```\nder die das und ich sie ist nicht ein eine mit für auf dem den\n```";
    expect(detectLanguage(`${english}\n${code}`).language).toBe("en");
    expect(detectLanguage(`${english} https://example.test/der/die/das/und/ich`).language).toBe(
      "en",
    );
    // Counter-probe: the same German outside quote and code is counted.
    expect(detectLanguage(`${english}\n${german}\n${german}`).language).toBe("de");
  });
});
describe("language decision", () => {
  const detected = { language: "de" as const, reason: "reliable" as const, words: 20 };
  const open = { language: null, reason: "ambiguous" as const, words: 20 };
  it("follows ticket choice, requester preference, detection, project default", () => {
    const base = { projectDefault: "en" };
    expect(
      decideLanguage({
        ...base,
        ticketChoice: "fr",
        requesterPreference: "de",
        detection: detected,
      }),
    ).toEqual({ language: "fr", source: "ticket", undecided: false });
    expect(decideLanguage({ ...base, requesterPreference: "de", detection: open })).toEqual({
      language: "de",
      source: "requester",
      undecided: false,
    });
    expect(decideLanguage({ ...base, detection: detected })).toEqual({
      language: "de",
      source: "detected",
      undecided: false,
    });
    expect(decideLanguage({ ...base, detection: open })).toEqual({
      language: "en",
      source: "project",
      undecided: true,
    });
    expect(decideLanguage(base)).toEqual({ language: "en", source: "project", undecided: false });
  });
});
const projectId = randomUUID();
const germanProject = randomUUID();
function mail(body: string, extra: string[] = []) {
  return Buffer.from(
    [
      `From: Kim <kim-${randomUUID()}@example.test>`,
      "To: support@example.test",
      "Subject: Login",
      `Message-ID: <${randomUUID()}@example.test>`,
      ...extra,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      "",
    ].join("\r\n"),
  );
}
async function ingest(raw: Buffer, project = projectId) {
  const { ingressId } = await acceptInbound({
    projectId: project,
    connectionId: null,
    externalKey: `test:${randomUUID()}`,
    raw,
  });
  await processIngress(ingressId);
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  const [ticket] = await db()
    .select()
    .from(tickets)
    .where(eq(tickets.id, entry?.ticketId ?? randomUUID()));
  const conversation = await db()
    .select()
    .from(messages)
    .where(eq(messages.ticketId, ticket?.id ?? randomUUID()))
    .orderBy(messages.createdAt);
  return { ticket, conversation };
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Language", slug: `language-${projectId}`, defaultLanguage: "en" },
      {
        id: germanProject,
        name: "Sprache",
        slug: `language-${germanProject}`,
        defaultLanguage: "de",
      },
    ]);
  const [outgoing] = await db()
    .insert(connections)
    .values({
      projectId: germanProject,
      kind: "smtp",
      name: "Out",
      direction: "outbound",
      status: "ready",
      config: {},
    })
    .returning({ id: connections.id });
  await db()
    .update(projects)
    .set({ settings: { outboundConnectionId: outgoing?.id, acknowledgements: true } })
    .where(eq(projects.id, germanProject));
});
afterAll(async () => {
  const ids = [projectId, germanProject];
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(ingress).where(inArray(ingress.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(connections).where(inArray(connections.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("language of tickets from inbound mail", () => {
  it("opens a ticket in the language of its first message and records the decision", async () => {
    const { ticket, conversation } = await ingest(mail(german));
    expect(ticket?.language).toBe("de");
    expect(conversation[0]).toMatchObject({
      language: "de",
      source: {
        languageDetection: { language: "de", reason: "reliable" },
        languageDecision: { source: "detected", undecided: false },
      },
    });
    const english2 = await ingest(mail(english), germanProject);
    expect(english2.ticket?.language).toBe("en");
  });
  it("falls back to the project default and says so when the language is unclear", async () => {
    for (const body of ["Help", `${german} ${english}`]) {
      const { ticket, conversation } = await ingest(mail(body));
      expect(ticket?.language).toBe("en");
      expect(conversation[0]?.source).toMatchObject({
        languageDecision: { source: "project", undecided: true },
      });
    }
    const german2 = await ingest(mail("Hilfe"), germanProject);
    expect(german2.ticket?.language).toBe("de");
  });
  it("acknowledges in the language of the ticket", async () => {
    const { conversation } = await ingest(mail(german), germanProject);
    const acknowledgement = conversation.find((message) => message.authorType === "system");
    expect(acknowledgement?.language).toBe("de");
    expect(acknowledgement?.markdown).toContain("erfasst");
    const other = await ingest(mail(english), germanProject);
    const second = other.conversation.find((message) => message.authorType === "system");
    expect(second?.language).toBe("en");
    expect(second?.markdown).toContain("recorded");
  });
  it("keeps the ticket language when a later message is written in another language", async () => {
    const first = await ingest(
      Buffer.from(
        [
          "From: Lee <lee@example.test>",
          "To: support@example.test",
          "Subject: Login",
          "Message-ID: <first-lang@example.test>",
          "Content-Type: text/plain",
          "",
          english,
          "",
        ].join("\r\n"),
      ),
    );
    const reply = await ingest(
      Buffer.from(
        [
          "From: Lee <lee@example.test>",
          "To: support@example.test",
          "Subject: Re: Login",
          `Message-ID: <${randomUUID()}@example.test>`,
          "In-Reply-To: <first-lang@example.test>",
          "Content-Type: text/plain",
          "",
          german,
          "",
        ].join("\r\n"),
      ),
    );
    expect(reply.ticket?.id).toBe(first.ticket?.id);
    expect(reply.ticket?.language).toBe("en");
    expect(reply.conversation.map((message) => message.language)).toEqual(["en", "de"]);
  });
});
