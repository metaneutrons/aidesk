import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, jobs, messages, projects, tickets, translations } from "../src/server/db/schema";
import {
  completeTranslation,
  correctMessage,
  deleteTranslations,
  failTranslation,
  listTranslations,
  requestTranslation,
} from "../src/server/translation";
import { checkProtected, protectedSegments } from "../src/domain/translation";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const staff: Principal = {
  id: `staff-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: ["project.read", "ticket.read", "ticket.reply", "ticket.note"] }],
};
const reader: Principal = {
  ...staff,
  id: `reader-${projectId}`,
  grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
};
const outsider: Principal = {
  ...staff,
  id: `outsider-${projectId}`,
  grants: [{ projectId: otherProject, actions: ["ticket.read", "ticket.reply"] }],
};
const source =
  "Der Build schlägt fehl:\n\n```\nnpm run build --prod\n```\n\nSiehe `config.json` und https://example.test/log?id=7, Mail an ops@example.test, Platzhalter {{name}}.";
const translated =
  "The build fails:\n\n```\nnpm run build --prod\n```\n\nSee `config.json` and https://example.test/log?id=7, mail to ops@example.test, placeholder {{name}}.";
async function message(options: { internal?: boolean; state?: string; junk?: boolean } = {}) {
  const [ticket] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Build",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "de",
      pendingSince: new Date(Date.now() - 3_600_000),
      junkAt: options.junk ? new Date() : null,
    })
    .returning();
  const [created] = await db()
    .insert(messages)
    .values({
      ticketId: ticket?.id ?? "",
      authorType: options.internal ? "human" : "customer",
      authorName: "Kim",
      markdown: source,
      language: "de",
      internal: options.internal === true,
      deliveryState: options.state ?? (options.internal ? "internal" : "received"),
    })
    .returning();
  return { ticketId: ticket?.id ?? "", messageId: created?.id ?? "", ticket };
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Translation", slug: `translation-${projectId}` },
      { id: otherProject, name: "Other", slug: `translation-${otherProject}` },
    ]);
});
afterAll(async () => {
  const ids = [projectId, otherProject];
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("protected content", () => {
  it("lists code, links, addresses and placeholders once each", () => {
    expect(protectedSegments(source)).toEqual(
      [
        "```\nnpm run build --prod\n```",
        "`config.json`",
        "https://example.test/log?id=7",
        "ops@example.test",
        "{{name}}",
      ].sort(),
    );
    // A link inside code belongs to the code.
    expect(protectedSegments("`curl https://example.test/x`")).toEqual([
      "`curl https://example.test/x`",
    ]);
    expect(protectedSegments("%s and %(user)s and {count} and %d")).toEqual(
      ["%s", "%(user)s", "{count}", "%d"].sort(),
    );
    // Sentence punctuation after a link is not part of it.
    expect(
      protectedSegments("See https://a.test/x. Then (https://b.test/y) or https://c.test/z!"),
    ).toEqual(["https://a.test/x", "https://b.test/y", "https://c.test/z"]);
    expect(protectedSegments("Plain text only.")).toEqual([]);
  });
  it("accepts a result that keeps them and refuses one that changes them", () => {
    expect(checkProtected(source, translated)).toEqual({
      ok: true,
      missing: [],
      added: [],
      numbersMissing: [],
      numbersAdded: [],
    });
    const bad: [string, string][] = [
      ["code changed", translated.replace("--prod", "--production")],
      ["link dropped", translated.replace("https://example.test/log?id=7", "the log")],
      ["placeholder translated", translated.replace("{{name}}", "{{Name}}")],
      ["address changed", translated.replace("ops@", "root@")],
      ["link added", `${translated}\nhttps://evil.test/`],
      ["duplicate dropped", `${source}\nhttps://example.test/a\nhttps://example.test/a`],
    ];
    for (const [name, text] of bad)
      expect(
        checkProtected(
          name === "duplicate dropped" ? text : source,
          name === "duplicate dropped" ? translated : text,
        ).ok,
        name,
      ).toBe(false);
    // Text without protected content accepts any plain translation but no injected link.
    expect(checkProtected("Hallo Welt", "Hello world").ok).toBe(true);
    expect(checkProtected("Hallo Welt", "Hello https://evil.test").ok).toBe(false);
    // Numbers are compared as digits: none may be added or lost, and the way of writing is free.
    expect(checkProtected("Hallo Welt", "Hello world 42")).toMatchObject({
      ok: false,
      numbersAdded: ["42"],
    });
    expect(checkProtected("Rechnung 4711", "Invoice")).toMatchObject({
      ok: false,
      numbersMissing: ["4711"],
    });
    expect(
      checkProtected("Betrag 1.250,50 EUR am 03.02.2026", "Amount 1,250.50 EUR on 3 February 2026")
        .ok,
    ).toBe(true);
  });
});
describe("translation records", () => {
  it("queues one record per revision and language and keeps the source usable", async () => {
    const { messageId, ticketId, ticket } = await message();
    const first = await requestTranslation(reader, messageId, "en");
    expect(first).toMatchObject({ status: "queued", language: "en" });
    expect((await requestTranslation(staff, messageId, "en")).id).toBe(first.id);
    expect(await listTranslations(reader, messageId)).toEqual([
      expect.objectContaining({ language: "en", status: "queued", markdown: null, current: true }),
    ]);
    // Nothing became a message or touched the response obligation.
    expect(await db().select().from(messages).where(eq(messages.ticketId, ticketId))).toHaveLength(
      1,
    );
    const [after] = await db().select().from(tickets).where(eq(tickets.id, ticketId));
    expect(after).toMatchObject({ revision: ticket?.revision, status: "open" });
    expect(after?.pendingSince?.getTime()).toBe(ticket?.pendingSince?.getTime());
    expect(
      (await db().select().from(messages).where(eq(messages.id, messageId)))[0]?.markdown,
    ).toBe(source);
  });
  it("refuses requests for the source language, unknown languages, junk and outsiders", async () => {
    const { messageId } = await message();
    await expect(requestTranslation(reader, messageId, "de")).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(requestTranslation(reader, messageId, "fr")).rejects.toThrow();
    await expect(requestTranslation(outsider, messageId, "en")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      requestTranslation({ ...reader, grants: [] }, messageId, "en"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(requestTranslation(reader, randomUUID(), "en")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(requestTranslation(reader, "nope", "en")).rejects.toThrow();
    const junk = await message({ junk: true });
    await expect(requestTranslation(staff, junk.messageId, "en")).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(listTranslations(outsider, messageId)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("stores a faithful result and renders it for readers", async () => {
    const { messageId } = await message();
    const { id } = await requestTranslation(reader, messageId, "en");
    expect(
      await completeTranslation(id, { markdown: translated, provenance: { method: "test" } }),
    ).toEqual({ status: "ready" });
    const [entry] = await listTranslations(reader, messageId);
    expect(entry).toMatchObject({ status: "ready", markdown: translated, current: true });
    expect(entry?.html).toContain("<pre>");
    // A finished one cannot be completed again.
    await expect(completeTranslation(id, { markdown: translated })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(failTranslation(id, "late")).rejects.toMatchObject({ code: "conflict" });
  });
  it("fails a result that changed protected content or is empty, and allows a retry", async () => {
    const { messageId } = await message();
    const { id } = await requestTranslation(reader, messageId, "en");
    expect(
      await completeTranslation(id, { markdown: translated.replace("{{name}}", "{{Name}}") }),
    ).toEqual({ status: "failed" });
    const [failed] = await db().select().from(translations).where(eq(translations.id, id));
    expect(failed).toMatchObject({
      status: "failed",
      markdown: null,
      provenance: { error: "protected_content_changed", missing: 1, added: 1 },
    });
    expect((await listTranslations(reader, messageId))[0]).toMatchObject({
      status: "failed",
      markdown: null,
    });
    expect(await requestTranslation(reader, messageId, "en")).toMatchObject({
      id,
      status: "queued",
    });
    expect(await completeTranslation(id, { markdown: "   " })).toEqual({ status: "failed" });
    expect(await requestTranslation(reader, messageId, "en")).toMatchObject({
      id,
      status: "queued",
    });
    expect(await failTranslation(id, "provider_unavailable")).toEqual({ status: "failed" });
    expect(
      (await db().select().from(translations).where(eq(translations.id, id)))[0]?.provenance,
    ).toEqual({ error: "provider_unavailable" });
    await expect(failTranslation(randomUUID(), "x")).rejects.toMatchObject({ code: "conflict" });
    await expect(completeTranslation(randomUUID(), { markdown: "x" })).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("shows text only for a finished translation of the current revision", async () => {
    const { messageId } = await message();
    const { id } = await requestTranslation(reader, messageId, "en");
    for (const status of ["queued", "failed", "stale"])
      await db()
        .update(translations)
        .set({ status, markdown: "left over text" })
        .where(eq(translations.id, id));
    for (const status of ["queued", "failed", "stale"]) {
      await db().update(translations).set({ status }).where(eq(translations.id, id));
      expect((await listTranslations(reader, messageId))[0]).toMatchObject({
        markdown: null,
        html: null,
      });
    }
    await db().update(translations).set({ status: "ready" }).where(eq(translations.id, id));
    expect((await listTranslations(reader, messageId))[0]).toMatchObject({
      markdown: "left over text",
    });
  });
  it("discards a result that arrives for an outdated revision", async () => {
    const { messageId } = await message();
    const { id } = await requestTranslation(reader, messageId, "en");
    await db().update(messages).set({ revision: 2 }).where(eq(messages.id, messageId));
    expect(await completeTranslation(id, { markdown: translated })).toEqual({ status: "stale" });
    expect((await listTranslations(reader, messageId))[0]).toMatchObject({
      status: "stale",
      markdown: null,
      current: false,
    });
  });
});
describe("corrections and deletion", () => {
  it("invalidates translations of the old revision and translates the new one separately", async () => {
    const { messageId, ticketId } = await message();
    const { id } = await requestTranslation(reader, messageId, "en");
    await completeTranslation(id, { markdown: translated });
    expect(await correctMessage(staff, messageId, "Neuer Text ohne Besonderheiten.")).toEqual({
      revision: 2,
    });
    const [old] = await listTranslations(reader, messageId);
    expect(old).toMatchObject({
      status: "stale",
      markdown: null,
      current: false,
      sourceRevision: 1,
    });
    expect(
      (await db().select().from(translations).where(eq(translations.id, id)))[0]?.markdown,
    ).toBeNull();
    const fresh = await requestTranslation(reader, messageId, "en");
    expect(fresh.id).not.toBe(id);
    expect(await listTranslations(reader, messageId)).toHaveLength(2);
    expect(
      await db()
        .select()
        .from(audit)
        .where(and(eq(audit.targetId, messageId), eq(audit.action, "message.correct"))),
    ).toHaveLength(1);
    expect((await db().select().from(tickets).where(eq(tickets.id, ticketId)))[0]?.status).toBe(
      "open",
    );
  });
  it("lets only the right people correct messages that were not sent", async () => {
    const received = await message();
    await expect(correctMessage(reader, received.messageId, "x")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      correctMessage({ ...staff, kind: "agent" }, received.messageId, "x"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(correctMessage(outsider, received.messageId, "x")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(correctMessage(staff, received.messageId, "  ")).rejects.toThrow();
    const sent = await message({ state: "sent" });
    await expect(correctMessage(staff, sent.messageId, "x")).rejects.toMatchObject({
      code: "conflict",
    });
    // A private note needs the note permission instead of the reply permission.
    const note = await message({ internal: true });
    const noteOnly: Principal = {
      ...staff,
      grants: [{ projectId, actions: ["ticket.read", "ticket.note"] }],
    };
    const replyOnly: Principal = {
      ...staff,
      grants: [{ projectId, actions: ["ticket.read", "ticket.reply"] }],
    };
    await expect(correctMessage(replyOnly, note.messageId, "x")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await correctMessage(noteOnly, note.messageId, "Korrigierte Notiz")).toEqual({
      revision: 2,
    });
    await expect(correctMessage(noteOnly, received.messageId, "x")).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("deletes derived content on request and with the ticket, never the source", async () => {
    const { messageId, ticketId } = await message();
    await completeTranslation((await requestTranslation(reader, messageId, "en")).id, {
      markdown: translated,
    });
    await expect(deleteTranslations(reader, messageId)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(deleteTranslations({ ...staff, kind: "agent" }, messageId)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await deleteTranslations(staff, messageId)).toEqual({ deleted: 1 });
    expect(await listTranslations(reader, messageId)).toEqual([]);
    expect(
      (await db().select().from(messages).where(eq(messages.id, messageId)))[0]?.markdown,
    ).toBe(source);
    await requestTranslation(reader, messageId, "en");
    await db().delete(tickets).where(eq(tickets.id, ticketId));
    expect(
      await db().select().from(translations).where(eq(translations.messageId, messageId)),
    ).toHaveLength(0);
  });
});
