import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  connections,
  ingress,
  jobs,
  messages,
  projects,
  tickets,
} from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import { listProjects, setProjectSettings } from "../src/server/operations";
import { initializeStorage } from "../src/server/storage";
import { setText } from "../src/server/texts";
import { acknowledgementText, isAutomaticMail } from "../src/domain/acknowledgement";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const quietProject = randomUUID();
const manager: Principal = {
  id: `manager-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [
    { projectId, actions: ["project.read", "project.manage", "ticket.read"] },
    { projectId: quietProject, actions: ["project.read", "ticket.read"] },
  ],
};
function mail(fields: {
  from?: string;
  subject?: string;
  headers?: string[];
  inReplyTo?: string;
}): Buffer {
  return Buffer.from(
    [
      `From: ${fields.from ?? "Kim <kim@example.test>"}`,
      "To: support@example.test",
      `Subject: ${fields.subject ?? `Question ${randomUUID()}`}`,
      `Message-ID: <${randomUUID()}@example.test>`,
      ...(fields.inReplyTo ? [`In-Reply-To: ${fields.inReplyTo}`] : []),
      ...(fields.headers ?? []),
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello",
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
  const ticketId = entry?.ticketId ?? "";
  const conversation = await db()
    .select()
    .from(messages)
    .where(eq(messages.ticketId, ticketId))
    .orderBy(messages.createdAt);
  return { ticketId, conversation };
}
const acknowledgements = (conversation: (typeof messages.$inferSelect)[]) =>
  conversation.filter((message) => message.authorType === "system");
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Ack", slug: `ack-${projectId}`, defaultLanguage: "de" },
      { id: quietProject, name: "Quiet", slug: `ack-${quietProject}` },
    ]);
  const [outgoing] = await db()
    .insert(connections)
    .values({
      projectId,
      kind: "smtp",
      name: "Test",
      direction: "outbound",
      status: "ready",
      config: {},
    })
    .returning({ id: connections.id });
  await db()
    .update(projects)
    .set({ settings: { outboundConnectionId: outgoing?.id } })
    .where(eq(projects.id, projectId));
});
afterAll(async () => {
  const ids = [projectId, quietProject];
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(ingress).where(inArray(ingress.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(connections).where(inArray(connections.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("automatic mail detection", () => {
  const headers = (entries: [string, unknown][]) => new Map(entries);
  it("recognises automatic and list mail", () => {
    const cases: [string, unknown][] = [
      ["auto-submitted", "auto-replied"],
      ["auto-submitted", "auto-generated"],
      ["precedence", "bulk"],
      ["precedence", "Junk"],
      ["list-id", { value: "<news.example.test>" }],
      ["list", { id: { name: "news.example.test" } }],
      ["list", { unsubscribe: { url: "https://example.test/u" } }],
      ["x-autoreply", "yes"],
      ["x-auto-response-suppress", "OOF, AutoReply"],
      ["return-path", "<>"],
      ["auto-submitted", { text: "auto-generated" }],
    ];
    for (const entry of cases)
      expect(isAutomaticMail(headers([entry]), "kim@example.test"), entry[0]).toBe(true);
    for (const sender of [
      "mailer-daemon@example.test",
      "postmaster@example.test",
      "no-reply@example.test",
      "noreply+tag@example.test",
      "do-not-reply@example.test",
      "bounces@example.test",
    ])
      expect(isAutomaticMail(headers([]), sender), sender).toBe(true);
  });
  it("answers people", () => {
    expect(isAutomaticMail(headers([]), "kim@example.test")).toBe(false);
    expect(isAutomaticMail(headers([["auto-submitted", "no"]]), "kim@example.test")).toBe(false);
    expect(isAutomaticMail(headers([["precedence", "normal"]]), "kim@example.test")).toBe(false);
    expect(
      isAutomaticMail(headers([["return-path", "<kim@example.test>"]]), "kim@example.test"),
    ).toBe(false);
    expect(isAutomaticMail(headers([]), "replyteam@example.test")).toBe(false);
    expect(isAutomaticMail(headers([["list", {}]]), "kim@example.test")).toBe(false);
    expect(isAutomaticMail(headers([["list", "plain"]]), "kim@example.test")).toBe(false);
    expect(isAutomaticMail(headers([["precedence", 42]]), "kim@example.test")).toBe(false);
  });
  it("writes the confirmation in the ticket language", () => {
    expect(acknowledgementText("de", 42)).toContain("unter der Nummer #42 erfasst");
    // German texts address the reader with "du", never "Sie".
    expect(acknowledgementText("de", 42)).toMatch(/deine Nachricht.*antworten dir/s);
    expect(acknowledgementText("de", 42)).not.toMatch(/\b(Sie|Ihre|Ihnen)\b/);
    expect(acknowledgementText("en-GB", 7)).toContain("recorded it as #7");
    expect(acknowledgementText("fr", 7)).toContain("recorded it as #7");
  });
});
describe("project settings", () => {
  it("lets project managers switch acknowledgements and audits the change", async () => {
    expect((await listProjects(manager)).find((p) => p.id === projectId)?.acknowledgements).toBe(
      false,
    );
    await expect(
      setProjectSettings(manager, quietProject, { acknowledgements: true }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      setProjectSettings({ ...manager, kind: "agent" }, projectId, { acknowledgements: true }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      setProjectSettings(manager, projectId, { acknowledgements: true, aiMode: "autonomous" }),
    ).rejects.toThrow();
    // At least one known setting is needed.
    await expect(setProjectSettings(manager, projectId, {})).rejects.toThrow();
    await expect(setProjectSettings(manager, projectId, { portalLinks: "yes" })).rejects.toThrow();
    expect((await listProjects(manager)).find((p) => p.id === projectId)?.portalLinks).toBe(false);
    expect(await setProjectSettings(manager, projectId, { portalLinks: true })).toEqual({
      portalLinks: true,
    });
    expect((await listProjects(manager)).find((p) => p.id === projectId)?.portalLinks).toBe(true);
    expect(await setProjectSettings(manager, projectId, { acknowledgements: true })).toEqual({
      acknowledgements: true,
    });
    // One setting does not change the other.
    expect((await listProjects(manager)).find((p) => p.id === projectId)?.portalLinks).toBe(true);
    expect((await listProjects(manager)).find((p) => p.id === projectId)?.acknowledgements).toBe(
      true,
    );
    // Other settings are kept.
    const [stored] = await db().select().from(projects).where(eq(projects.id, projectId));
    expect(typeof stored?.settings.outboundConnectionId).toBe("string");
    expect(
      await db()
        .select()
        .from(audit)
        .where(and(eq(audit.projectId, projectId), eq(audit.action, "project.settings"))),
    ).toHaveLength(2);
  });
});
describe("acknowledgements", () => {
  it("uses the project's own wording when it set one, and the built-in wording otherwise", async () => {
    const writer: Principal = {
      ...manager,
      grants: [{ projectId, actions: ["project.read", "config.read", "config.write"] }],
    };
    const own = "Eingegangen als #{number}. Wir melden uns.";
    await setText(writer, projectId, "acknowledgement", "de", { text: own, expectedVersion: 0 });
    const { ticketId, conversation } = await ingest(mail({ from: "Own <own@example.test>" }));
    const [ticket] = await db().select().from(tickets).where(eq(tickets.id, ticketId));
    expect(acknowledgements(conversation)[0]?.markdown).toBe(
      `Eingegangen als #${String(ticket?.number ?? "")}. Wir melden uns.`,
    );
    // The wording is per language: an English ticket keeps the built-in text.
    const english = await ingest(
      Buffer.from(
        mail({ from: "En <en@example.test>" })
          .toString("utf8")
          .replace(
            "Hello\r\n",
            "Hello, I have a problem with the billing of my invoice and need help soon.\r\n",
          ),
      ),
    );
    expect(acknowledgements(english.conversation)[0]).toMatchObject({ language: "en" });
    expect(acknowledgements(english.conversation)[0]?.markdown ?? "").toContain("recorded it as #");
    await setText(writer, projectId, "acknowledgement", "de", { text: null, expectedVersion: 1 });
    const after = await ingest(mail({ from: "Back <back@example.test>" }));
    expect(acknowledgements(after.conversation)[0]?.markdown).toContain("unter der Nummer #");
  });
  it("queues one acknowledgement for a new ticket from a person", async () => {
    const { ticketId, conversation } = await ingest(mail({ from: "Kim <kim@example.test>" }));
    const [acknowledgement] = acknowledgements(conversation);
    const [ticket] = await db().select().from(tickets).where(eq(tickets.id, ticketId));
    expect(acknowledgement).toMatchObject({
      authorName: "Ack",
      internal: false,
      language: "de",
      deliveryState: "queued",
      source: { kind: "acknowledgement" },
    });
    expect(acknowledgement?.markdown).toContain(`#${String(ticket?.number ?? "")}`);
    const [job] = await db()
      .select()
      .from(jobs)
      .where(eq(jobs.dedupKey, `acknowledgement:${ticketId}`));
    expect(job?.payload).toMatchObject({
      ticketId,
      messageId: acknowledgement?.id,
      actorKind: "system",
      resolve: false,
    });
    // The obligation to answer is unchanged.
    expect(ticket?.pendingSince).not.toBeNull();
    // A reply in the same ticket is not acknowledged again.
    const reply = await ingest(
      mail({ from: "Kim <kim@example.test>", inReplyTo: conversation[0]?.receivedMessageId ?? "" }),
    );
    expect(reply.ticketId).toBe(ticketId);
    expect(acknowledgements(reply.conversation)).toHaveLength(1);
    // A second new ticket from the same address within the hour is not.
    const second = await ingest(mail({ from: "Kim <kim@example.test>" }));
    expect(second.ticketId).not.toBe(ticketId);
    expect(acknowledgements(second.conversation)).toHaveLength(0);
    // Another person is.
    const other = await ingest(mail({ from: "Lee <lee@example.test>" }));
    expect(acknowledgements(other.conversation)).toHaveLength(1);
  });
  it("never answers automatic mail", async () => {
    for (const raw of [
      mail({ from: "Ana <ana@example.test>", headers: ["Auto-Submitted: auto-replied"] }),
      mail({ from: "Bo <bo@example.test>", headers: ["Precedence: bulk"] }),
      mail({ from: "Cy <cy@example.test>", headers: ["List-Id: <news.example.test>"] }),
      mail({ from: "MAILER-DAEMON@example.test" }),
      mail({ from: "Shop <noreply@example.test>" }),
    ]) {
      const { ticketId, conversation } = await ingest(raw);
      expect(ticketId).not.toBe("");
      expect(acknowledgements(conversation)).toHaveLength(0);
    }
  });
  it("stays silent when the project has acknowledgements off", async () => {
    const { conversation } = await ingest(mail({ from: "Dee <dee@example.test>" }), quietProject);
    expect(conversation).toHaveLength(1);
    expect(acknowledgements(conversation)).toHaveLength(0);
  });
});
