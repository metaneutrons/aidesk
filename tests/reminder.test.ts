import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, jobs, projects, tickets } from "../src/server/db/schema";
import { getTicket, listTickets, reply, setReminder } from "../src/server/operations";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const noter: Principal = {
  id: `noter-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: ["project.read", "ticket.read", "ticket.note", "ticket.reply"] }],
};
const reader: Principal = {
  ...noter,
  id: `reader-${projectId}`,
  grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
};
async function ticket(project = projectId, junk = false) {
  const [created] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject: "Reminder",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      junkAt: junk ? new Date() : null,
    })
    .returning();
  return created;
}
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Reminder", slug: `reminder-${projectId}` },
      { id: otherProject, name: "Other", slug: `reminder-${otherProject}` },
    ]);
});
afterAll(async () => {
  const ids = [projectId, otherProject];
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("reminders", () => {
  it("sets, shows and clears a reminder without touching the conversation", async () => {
    const created = await ticket();
    const id = created?.id ?? "";
    const when = inDays(3);
    const result = await setReminder(noter, id, { remindAt: when });
    expect(result.remindAt?.toISOString()).toBe(new Date(when).toISOString());
    const { ticket: shown } = await getTicket(reader, id);
    expect(shown.remindAt?.toISOString()).toBe(new Date(when).toISOString());
    expect((await listTickets(reader)).find((entry) => entry.id === id)?.remindAt).not.toBeNull();
    // The revision that protects replies is unchanged, so a draft written before stays valid.
    expect(shown.revision).toBe(created?.revision);
    await reply(noter, id, {
      markdown: "Answer",
      language: "en",
      expectedRevision: shown.revision,
      idempotencyKey: randomUUID(),
      internal: true,
    });
    // Setting the same time again is harmless; clearing removes it.
    await setReminder(noter, id, { remindAt: when });
    expect(await setReminder(noter, id, { remindAt: null })).toEqual({ remindAt: null });
    expect((await getTicket(reader, id)).ticket.remindAt).toBeNull();
    const actions = (
      await db().select({ action: audit.action }).from(audit).where(eq(audit.targetId, id))
    ).map((row) => row.action);
    expect(actions.filter((action) => action === "ticket.remind")).toHaveLength(2);
    expect(actions).toContain("ticket.remind_clear");
  });
  it("accepts a time in the past (due at once) and refuses a year out of range", async () => {
    const id = (await ticket())?.id ?? "";
    await expect(setReminder(noter, id, { remindAt: inDays(-1) })).resolves.toMatchObject({
      remindAt: expect.any(Date),
    });
    await expect(setReminder(noter, id, { remindAt: inDays(400) })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(setReminder(noter, id, { remindAt: inDays(-400) })).rejects.toMatchObject({
      code: "invalid_input",
    });
    for (const bad of [
      {},
      { remindAt: "tomorrow" },
      { remindAt: 5 },
      { remindAt: undefined },
      { remindAt: inDays(1), by: "me" },
    ])
      await expect(setReminder(noter, id, bad)).rejects.toThrow();
    // The refused values left the earlier one in place.
    expect((await getTicket(reader, id)).ticket.remindAt).not.toBeNull();
  });
  it("needs the right to write notes in the project and a ticket that is not junk", async () => {
    const id = (await ticket())?.id ?? "";
    const when = { remindAt: inDays(1) };
    await expect(setReminder(reader, id, when)).rejects.toMatchObject({ code: "forbidden" });
    await expect(setReminder({ ...noter, grants: [] }, id, when)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(setReminder({ ...noter, active: false }, id, when)).rejects.toMatchObject({
      code: "not_found",
    });
    const foreign = (await ticket(otherProject))?.id ?? "";
    await expect(setReminder(noter, foreign, when)).rejects.toMatchObject({ code: "not_found" });
    const junk = (await ticket(projectId, true))?.id ?? "";
    await expect(setReminder(noter, junk, when)).rejects.toMatchObject({ code: "conflict" });
    await expect(setReminder(noter, "nope", when)).rejects.toThrow();
    expect(
      await db()
        .select()
        .from(audit)
        .where(and(eq(audit.targetId, id), eq(audit.action, "ticket.remind"))),
    ).toHaveLength(0);
  });
});
