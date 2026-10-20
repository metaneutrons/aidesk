import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  aiRuns,
  attachments,
  attachmentTexts,
  audit,
  ingress,
  jobs,
  memberships,
  messages,
  projects,
  tickets,
  translations,
  user,
} from "../src/server/db/schema";
import { countDue, previewRetention, runRetention, scanRetention } from "../src/server/retention";
import { restoreJunkMail } from "../src/server/operations";
import { getObject, initializeStorage, putObject } from "../src/server/storage";
import {
  maxRetentionDays,
  retentionKey,
  retentionKinds,
  retentionOf,
  retentionPreviewInput,
  retentionSuggestions,
  tightens,
} from "../src/domain/retention";
import type { Action, Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectId = randomUUID();
const otherProject = randomUUID();
const day = 86_400_000;
const now = new Date("2026-10-20T12:00:00.000Z");
const ago = (days: number, extra = 0) => new Date(now.getTime() - days * day - extra);
const person = (held: Action[], project = projectId): Principal => ({
  id: `ret-${run}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId: project, actions: held }],
});
const reader = person(["project.read", "config.read"]);
const junkRestorer = person(["project.read", "ticket.read", "ticket.junk"]);
const outsider = person(["config.read"], otherProject);
const periods = (change: Partial<Record<(typeof retentionKinds)[number], number | null>>) => ({
  tickets: null,
  attachments: null,
  originals: null,
  translations: null,
  aiRuns: null,
  ...change,
});
const setPeriods = (values: ReturnType<typeof periods>, project = projectId) =>
  db()
    .update(projects)
    .set({
      settings: Object.fromEntries(
        retentionKinds.map((kind) => [retentionKey(kind), values[kind]]),
      ),
    })
    .where(eq(projects.id, project));
const exists = (key: string) =>
  getObject(key).then(
    () => true,
    () => false,
  );
const key = (name: string) => `attachments/${projectId}/${run}-${name}`;
const original = (name: string) => `inbound/${projectId}/${run}-${name}.eml`;
async function ticket(values: Partial<typeof tickets.$inferInsert>) {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Retention",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      ...values,
    })
    .returning({ id: tickets.id });
  return row?.id ?? "";
}
async function message(ticketId: string, createdAt: Date, rawObjectKey: string | null = null) {
  const [row] = await db()
    .insert(messages)
    .values({
      ticketId,
      authorType: "customer",
      authorName: "Kim",
      markdown: "Hello",
      createdAt,
      rawObjectKey,
    })
    .returning({ id: messages.id });
  return row?.id ?? "";
}
async function file(messageId: string, objectKey: string, createdAt: Date) {
  await putObject(objectKey, Buffer.from(objectKey), "text/plain");
  const [row] = await db()
    .insert(attachments)
    .values({
      messageId,
      projectId,
      position: 0,
      filename: "f.txt",
      contentType: "text/plain",
      size: 5,
      checksum: objectKey,
      objectKey,
      createdAt,
    })
    .returning({ id: attachments.id });
  await db()
    .insert(attachmentTexts)
    .values({ attachmentId: row?.id ?? "", projectId, version: 1, text: "text" });
  return row?.id ?? "";
}
const clear = async () => {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(ingress).where(eq(ingress.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(aiRuns).where(eq(aiRuns.projectId, projectId));
  await setPeriods(periods({}));
  await db().update(projects).set({ archivedAt: null }).where(eq(projects.id, projectId));
};
const auditOf = async (action: string) =>
  (await db().select().from(audit).where(eq(audit.projectId, projectId))).filter(
    (entry) => entry.action === action,
  );
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Retention", slug: `ret-${run}` },
      { id: otherProject, name: "Other", slug: `ret-other-${run}` },
    ]);
  await db()
    .insert(user)
    .values({
      id: reader.id,
      name: "Reader",
      email: `${reader.id}@example.test`,
      emailVerified: true,
    });
  await db()
    .insert(memberships)
    .values({ userId: reader.id, projectId, actions: ["project.read", "config.read"] });
}, 60_000);
afterAll(async () => {
  await clear();
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProject]));
  await db().delete(user).where(eq(user.id, reader.id));
  await sqlClient().end();
});
describe("the periods", () => {
  it("are off unless a valid number of days is stored, and none is suggested into a project", () => {
    expect(retentionOf({})).toEqual(periods({}));
    expect(
      retentionOf({
        retentionTicketsDays: 30,
        retentionAiRunsDays: "9",
        retentionOriginalsDays: 0,
        retentionTranslationsDays: maxRetentionDays + 1,
        retentionAttachmentsDays: 1.5,
      }),
    ).toEqual(periods({ tickets: 30 }));
    expect(retentionKey("aiRuns")).toBe("retentionAiRunsDays");
    expect(Object.keys(retentionSuggestions)).toEqual([...retentionKinds]);
  });
  it("tighten when set where there was none or made shorter", () => {
    expect(tightens(periods({}), periods({ tickets: 30 }))).toEqual(["tickets"]);
    expect(tightens(periods({ tickets: 30 }), periods({ tickets: 20 }))).toEqual(["tickets"]);
    expect(tightens(periods({ tickets: 30 }), periods({ tickets: 30 }))).toEqual([]);
    expect(tightens(periods({ tickets: 30 }), periods({ tickets: 60 }))).toEqual([]);
    expect(tightens(periods({ tickets: 30 }), periods({}))).toEqual([]);
    expect(tightens(periods({ tickets: 30 }), periods({ tickets: 60, aiRuns: 5 }))).toEqual([
      "aiRuns",
    ]);
    expect(retentionPreviewInput.safeParse(periods({ tickets: 0 })).success).toBe(false);
    expect(retentionPreviewInput.safeParse({ tickets: 5 }).success).toBe(false);
  });
});
describe("what is due", () => {
  it("counts a resolved or junk ticket past the period, and never an open one or one at the limit", async () => {
    await clear();
    await ticket({ status: "resolved", resolvedAt: ago(31) });
    await ticket({ status: "resolved", resolvedAt: ago(30, -1000) });
    await ticket({ status: "resolved", resolvedAt: ago(30, 1000) });
    await ticket({ status: "open", createdAt: ago(400) });
    await ticket({ status: "waiting", createdAt: ago(400) });
    // A ticket that was reopened keeps the date of its resolution and is open again.
    await ticket({ status: "open", resolvedAt: ago(400) });
    await ticket({ status: "open", junkAt: ago(40), createdAt: ago(400) });
    await ticket({ status: "open", junkAt: ago(10) });
    const due = await countDue(projectId, periods({ tickets: 30 }), now);
    expect(due).toMatchObject({ tickets: 3 });
    expect(await countDue(projectId, periods({}), now)).toEqual({
      tickets: 0,
      attachments: 0,
      originals: 0,
      translations: 0,
      aiRuns: 0,
    });
  });
  it("counts files, originals, translations and runs by their own dates, per project", async () => {
    await clear();
    const id = await ticket({});
    const old = await message(id, ago(100), original("old"));
    const recent = await message(id, ago(1), original("recent"));
    await file(old, key("old"), ago(100));
    await file(recent, key("recent"), ago(1));
    await db()
      .insert(translations)
      .values([
        { messageId: old, sourceRevision: 1, language: "de", createdAt: ago(100) },
        { messageId: recent, sourceRevision: 1, language: "de", createdAt: ago(1) },
      ]);
    await db()
      .insert(aiRuns)
      .values([
        {
          projectId,
          task: "reply.draft",
          outcome: "ok",
          durationMs: 1,
          actorKind: "human",
          actorId: "x",
          createdAt: ago(100),
        },
        {
          projectId,
          task: "reply.draft",
          outcome: "ok",
          durationMs: 1,
          actorKind: "human",
          actorId: "x",
          createdAt: ago(1),
        },
      ]);
    await db()
      .insert(aiRuns)
      .values({
        projectId: otherProject,
        task: "reply.draft",
        outcome: "ok",
        durationMs: 1,
        actorKind: "human",
        actorId: "x",
        createdAt: ago(100),
      });
    await db()
      .insert(ingress)
      .values([
        {
          projectId,
          externalKey: `k:${run}:1`,
          rawObjectKey: original("old"),
          checksum: "a",
          state: "processed",
          receivedAt: ago(100),
        },
        {
          projectId,
          externalKey: `k:${run}:2`,
          rawObjectKey: original("queued"),
          checksum: "b",
          state: "queued",
          receivedAt: ago(100),
        },
        {
          projectId,
          externalKey: `k:${run}:3`,
          rawObjectKey: original("recent"),
          checksum: "c",
          state: "processed",
          receivedAt: ago(1),
        },
      ]);
    const due = await countDue(
      projectId,
      periods({ attachments: 30, originals: 30, translations: 30, aiRuns: 30 }),
      now,
    );
    expect(due).toEqual({ tickets: 0, attachments: 1, originals: 2, translations: 1, aiRuns: 1 });
    await db().delete(aiRuns).where(eq(aiRuns.projectId, otherProject));
  });
  it("is shown as a dry run to a person who may read the configuration, and changes nothing", async () => {
    await clear();
    await ticket({ status: "resolved", resolvedAt: ago(400) });
    expect(await previewRetention(reader, projectId, periods({ tickets: 365 }))).toMatchObject({
      due: { tickets: 1 },
    });
    expect(await previewRetention(reader, projectId, periods({ tickets: 730 }))).toMatchObject({
      due: { tickets: 0 },
    });
    expect((await db().select().from(tickets).where(eq(tickets.projectId, projectId))).length).toBe(
      1,
    );
    await setPeriods(periods({ aiRuns: 5 }));
    expect((await previewRetention(reader, projectId, undefined)).periods).toEqual(
      periods({ aiRuns: 5 }),
    );
    await expect(previewRetention(outsider, projectId, periods({}))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(previewRetention(reader, randomUUID(), periods({}))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(previewRetention(reader, projectId, { tickets: 0 })).rejects.toThrow();
  });
});
describe("removing what is due", () => {
  it("erases tickets past the period with their files, leaves the others, and writes counts without content", async () => {
    await clear();
    const gone = await ticket({
      status: "resolved",
      resolvedAt: ago(40),
      subject: "Secret subject",
    });
    const stays = await ticket({ status: "resolved", resolvedAt: ago(5) });
    const open = await ticket({ status: "open", createdAt: ago(400) });
    const goneMessage = await message(gone, ago(41), original("gone"));
    await file(goneMessage, key("gone"), ago(41));
    await setPeriods(periods({ tickets: 30 }));
    const done = await runRetention(projectId, now);
    expect(done.tickets).toBe(1);
    expect(
      (
        await db()
          .select()
          .from(tickets)
          .where(inArray(tickets.id, [gone, stays, open]))
      )
        .map((row) => row.id)
        .sort(),
    ).toEqual([stays, open].sort());
    expect(await exists(key("gone"))).toBe(false);
    const entries = [...(await auditOf("retention.erase")), ...(await auditOf("retention.run"))];
    expect(entries.map((entry) => entry.actorId)).toEqual(["system", "system"]);
    expect(JSON.stringify(entries)).not.toContain("Secret subject");
    expect(JSON.stringify(entries)).not.toContain("kim@example.test");
    expect((await auditOf("retention.run"))[0]?.detail).toMatchObject({
      counts: { tickets: 1 },
      periods: { tickets: 30 },
    });
  });
  it("works in steps and says nothing when nothing is due", async () => {
    await clear();
    for (let index = 0; index < 5; index += 1)
      await ticket({ status: "resolved", resolvedAt: ago(40 + index) });
    await setPeriods(periods({ tickets: 30 }));
    expect((await runRetention(projectId, now, 2)).tickets).toBe(2);
    expect((await runRetention(projectId, now, 2)).tickets).toBe(2);
    expect((await runRetention(projectId, now, 2)).tickets).toBe(1);
    const entries = (await auditOf("retention.run")).length;
    expect(await runRetention(projectId, now, 2)).toEqual({
      tickets: 0,
      attachments: 0,
      originals: 0,
      translations: 0,
      aiRuns: 0,
    });
    expect((await auditOf("retention.run")).length).toBe(entries);
  });
  it("removes the file of an attachment and its text, keeps the row, and keeps a file that a newer attachment shares", async () => {
    await clear();
    const id = await ticket({});
    const old = await message(id, ago(100));
    const recent = await message(id, ago(1));
    const oldFile = await file(old, key("own"), ago(100));
    const sharedOld = await file(old, key("shared"), ago(100));
    await file(recent, key("shared"), ago(1));
    await setPeriods(periods({ attachments: 30 }));
    const done = await runRetention(projectId, now);
    expect(done.attachments).toBe(2);
    const [row] = await db().select().from(attachments).where(eq(attachments.id, oldFile));
    expect(row).toMatchObject({ objectKey: null, refusal: "removed_by_retention" });
    expect(
      (
        await db()
          .select()
          .from(attachmentTexts)
          .where(inArray(attachmentTexts.attachmentId, [oldFile, sharedOld]))
      ).length,
    ).toBe(0);
    expect(await exists(key("own"))).toBe(false);
    // The newer attachment still names the shared file.
    expect(await exists(key("shared"))).toBe(true);
  });
  it("removes the original of a mail from the message and the entry, keeps the entry, and does not touch a mail still to be read", async () => {
    await clear();
    const id = await ticket({});
    await message(id, ago(100), original("a"));
    await db()
      .insert(ingress)
      .values([
        {
          projectId,
          externalKey: `k:${run}:a`,
          rawObjectKey: original("a"),
          checksum: "a",
          state: "processed",
          parsed: { from: "kim@example.test" },
          receivedAt: ago(100),
        },
        {
          projectId,
          externalKey: `k:${run}:q`,
          rawObjectKey: original("q"),
          checksum: "q",
          state: "queued",
          receivedAt: ago(100),
        },
        {
          projectId,
          externalKey: `k:${run}:j`,
          rawObjectKey: original("j"),
          checksum: "j",
          state: "junk",
          parsed: { from: "x@example.test" },
          receivedAt: ago(100),
        },
      ]);
    await putObject(original("a"), Buffer.from("a"), "message/rfc822");
    await putObject(original("q"), Buffer.from("q"), "message/rfc822");
    await putObject(original("j"), Buffer.from("j"), "message/rfc822");
    await setPeriods(periods({ originals: 30 }));
    expect((await runRetention(projectId, now)).originals).toBe(3);
    const entries = await db().select().from(ingress).where(eq(ingress.projectId, projectId));
    expect(entries.find((entry) => entry.externalKey.endsWith(":a"))).toMatchObject({
      rawObjectKey: "",
      parsed: null,
      state: "processed",
    });
    expect(entries.find((entry) => entry.externalKey.endsWith(":q"))?.rawObjectKey).toBe(
      original("q"),
    );
    expect(
      (await db().select().from(messages).where(eq(messages.ticketId, id)))[0]?.rawObjectKey,
    ).toBeNull();
    expect(await exists(original("a"))).toBe(false);
    expect(await exists(original("j"))).toBe(false);
    expect(await exists(original("q"))).toBe(true);
    // A junk mail whose original is gone cannot be restored.
    const junk = entries.find((entry) => entry.externalKey.endsWith(":j"));
    await expect(restoreJunkMail(junkRestorer, junk?.id ?? "")).rejects.toThrow();
  });
  it("removes old translations and records of runs, and only those of its own project", async () => {
    await clear();
    const id = await ticket({});
    const old = await message(id, ago(100));
    await db()
      .insert(translations)
      .values([
        { messageId: old, sourceRevision: 1, language: "de", createdAt: ago(100) },
        { messageId: old, sourceRevision: 2, language: "de", createdAt: ago(1) },
      ]);
    await db()
      .insert(aiRuns)
      .values([
        {
          projectId,
          task: "reply.draft",
          outcome: "ok",
          durationMs: 1,
          actorKind: "human",
          actorId: "x",
          createdAt: ago(100),
        },
        {
          projectId,
          task: "reply.draft",
          outcome: "ok",
          durationMs: 1,
          actorKind: "human",
          actorId: "x",
          createdAt: ago(1),
        },
        {
          projectId: otherProject,
          task: "reply.draft",
          outcome: "ok",
          durationMs: 1,
          actorKind: "human",
          actorId: "x",
          createdAt: ago(100),
        },
      ]);
    await setPeriods(periods({ translations: 30, aiRuns: 30 }));
    expect(await runRetention(projectId, now)).toMatchObject({ translations: 1, aiRuns: 1 });
    expect(
      (await db().select().from(translations).where(eq(translations.messageId, old))).length,
    ).toBe(1);
    expect((await db().select().from(aiRuns).where(eq(aiRuns.projectId, projectId))).length).toBe(
      1,
    );
    expect(
      (await db().select().from(aiRuns).where(eq(aiRuns.projectId, otherProject))).length,
    ).toBe(1);
    await db().delete(aiRuns).where(eq(aiRuns.projectId, otherProject));
  });
  it("removes nothing where no period is set, and nothing from an archived project", async () => {
    await clear();
    await ticket({ status: "resolved", resolvedAt: ago(400) });
    expect(await runRetention(projectId, now)).toEqual({
      tickets: 0,
      attachments: 0,
      originals: 0,
      translations: 0,
      aiRuns: 0,
    });
    await setPeriods(periods({ tickets: 30 }));
    await db().update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId));
    expect((await runRetention(projectId, now)).tickets).toBe(0);
    expect((await scanRetention(now)).tickets).toBe(0);
    expect((await db().select().from(tickets).where(eq(tickets.projectId, projectId))).length).toBe(
      1,
    );
    await db().update(projects).set({ archivedAt: null }).where(eq(projects.id, projectId));
  });
  it("is run for every project that has a period by the scan, and for no other", async () => {
    await clear();
    const mine = await ticket({ status: "resolved", resolvedAt: ago(40) });
    const [theirs] = await db()
      .insert(tickets)
      .values({
        projectId: otherProject,
        subject: "Theirs",
        requesterEmail: "kim@example.test",
        requesterName: "Kim",
        language: "en",
        status: "resolved",
        resolvedAt: ago(400),
      })
      .returning({ id: tickets.id });
    await setPeriods(periods({ tickets: 30 }));
    expect((await scanRetention(now)).tickets).toBeGreaterThanOrEqual(1);
    expect((await db().select().from(tickets).where(eq(tickets.id, mine))).length).toBe(0);
    expect(
      (
        await db()
          .select()
          .from(tickets)
          .where(eq(tickets.id, theirs?.id ?? ""))
      ).length,
    ).toBe(1);
    await db().delete(tickets).where(eq(tickets.projectId, otherProject));
  });
});
