import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, projects, tickets } from "../src/server/db/schema";
import {
  getTicket,
  listTags,
  listTickets,
  maxTags,
  normalizeTag,
  searchTickets,
  setTicketTags,
} from "../src/server/operations";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const noter: Principal = {
  id: `noter-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: ["project.read", "ticket.read", "ticket.note"] }],
};
const reader: Principal = {
  ...noter,
  id: `reader-${projectId}`,
  grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
};
async function ticket(project = projectId, options: { junk?: boolean; tags?: string[] } = {}) {
  const [created] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject: "Tags",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      junkAt: options.junk ? new Date() : null,
      tags: options.tags ?? [],
    })
    .returning();
  return created;
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Tags", slug: `tags-${projectId}` },
      { id: otherProject, name: "Other", slug: `tags-${otherProject}` },
    ]);
});
afterAll(async () => {
  const ids = [projectId, otherProject];
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("normalizing a tag", () => {
  it("lowercases, trims and joins words with a hyphen", () => {
    expect(normalizeTag("  VIP Customer  ")).toBe("vip-customer");
    expect(normalizeTag("Billing")).toBe("billing");
    expect(normalizeTag("a   b\tc")).toBe("a-b-c");
    expect(normalizeTag("ＦＵＬＬ")).toBe("full");
  });
});
describe("setting tags", () => {
  it("stores a normalized, sorted list, replaces it as a whole and leaves the conversation alone", async () => {
    const created = await ticket();
    const id = created?.id ?? "";
    expect(
      await setTicketTags(noter, id, { tags: [" Billing ", "VIP customer", "billing", "München"] }),
    ).toEqual({
      tags: ["billing", "münchen", "vip-customer"],
    });
    const { ticket: shown } = await getTicket(reader, id);
    expect(shown.tags).toEqual(["billing", "münchen", "vip-customer"]);
    expect(shown.revision).toBe(created?.revision);
    expect((await listTickets(reader)).find((entry) => entry.id === id)?.tags).toEqual(shown.tags);
    expect(await setTicketTags(noter, id, { tags: ["urgent"] })).toEqual({ tags: ["urgent"] });
    expect(await setTicketTags(noter, id, { tags: [] })).toEqual({ tags: [] });
    expect((await getTicket(reader, id)).ticket.tags).toEqual([]);
    expect(await db().select().from(audit).where(eq(audit.targetId, id))).toHaveLength(3);
  });
  it("refuses lists and tags that are not in the allowed form", async () => {
    const id = (await ticket())?.id ?? "";
    await setTicketTags(noter, id, { tags: ["keep"] });
    const many = Array.from({ length: maxTags + 1 }, (_, index) => `tag${String(index)}`);
    for (const bad of [
      { tags: many },
      { tags: [""] },
      { tags: ["   "] },
      { tags: ["a".repeat(31)] },
      { tags: ["-leading"] },
      { tags: ["_leading"] },
      { tags: ["with!bang"] },
      { tags: ["a,b"] },
      { tags: ["<b>"] },
      { tags: "billing" },
      { tags: [5] },
      { tags: ["ok"], extra: true },
      {},
    ])
      await expect(setTicketTags(noter, id, bad), JSON.stringify(bad)).rejects.toThrow();
    // Exactly the limit and exactly 30 characters are fine; duplicates count once.
    expect(maxTags).toBe(10);
    const ten = Array.from({ length: maxTags }, (_, index) => `tag${String(index)}`);
    expect((await setTicketTags(noter, id, { tags: [...ten, ...ten] })).tags).toHaveLength(maxTags);
    expect((await setTicketTags(noter, id, { tags: ["a".repeat(30)] })).tags).toEqual([
      "a".repeat(30),
    ]);
    // The refused calls left the list unchanged until the valid ones.
    await setTicketTags(noter, id, { tags: ["keep"] });
    await expect(setTicketTags(noter, id, { tags: ["bad tag!"] })).rejects.toThrow();
    expect((await getTicket(reader, id)).ticket.tags).toEqual(["keep"]);
  });
  it("needs the right to write notes and a ticket outside junk", async () => {
    const id = (await ticket())?.id ?? "";
    await expect(setTicketTags(reader, id, { tags: ["x1"] })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      setTicketTags({ ...noter, grants: [] }, id, { tags: ["x1"] }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      setTicketTags({ ...noter, active: false }, id, { tags: ["x1"] }),
    ).rejects.toMatchObject({ code: "not_found" });
    const foreign = (await ticket(otherProject))?.id ?? "";
    await expect(setTicketTags(noter, foreign, { tags: ["x1"] })).rejects.toMatchObject({
      code: "not_found",
    });
    const junk = (await ticket(projectId, { junk: true }))?.id ?? "";
    await expect(setTicketTags(noter, junk, { tags: ["x1"] })).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await getTicket(reader, id)).ticket.tags).toEqual([]);
  });
});
describe("tags in use", () => {
  it("counts them for the authorized projects, most used first, without junk or other projects", async () => {
    const word = `u${randomUUID().slice(0, 6)}`;
    await ticket(projectId, { tags: [`${word}-a`, `${word}-b`] });
    await ticket(projectId, { tags: [`${word}-a`] });
    await ticket(projectId, { junk: true, tags: [`${word}-a`, `${word}-junk`] });
    await ticket(otherProject, { tags: [`${word}-a`, `${word}-other`] });
    const mine = (await listTags(reader)).filter((entry) => entry.tag.startsWith(word));
    expect(mine).toEqual([
      { tag: `${word}-a`, count: 2 },
      { tag: `${word}-b`, count: 1 },
    ]);
    await expect(listTags(reader, [otherProject])).rejects.toMatchObject({ code: "not_found" });
    expect(await listTags({ ...reader, grants: [] })).toEqual([]);
    const both: Principal = {
      ...reader,
      grants: [...reader.grants, { projectId: otherProject, actions: ["ticket.read"] }],
    };
    expect((await listTags(both, [otherProject])).map((entry) => entry.tag)).toContain(
      `${word}-other`,
    );
    expect((await listTags(both)).find((entry) => entry.tag === `${word}-a`)?.count).toBe(3);
    await expect(listTags(reader, ["not-a-uuid"])).rejects.toThrow();
  });
  it("lets the search find a ticket by its tag", async () => {
    const word = `findme${randomUUID().slice(0, 6)}`;
    const id = (await ticket(projectId, { tags: [word] }))?.id ?? "";
    await ticket(projectId, { tags: ["unrelated"] });
    expect((await searchTickets(reader, word.toUpperCase())).map((entry) => entry.id)).toEqual([
      id,
    ]);
    expect((await searchTickets(reader, word.slice(0, -2))).map((entry) => entry.id)).toContain(id);
  });
});
