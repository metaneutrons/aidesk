import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, projectTags, projects, tickets } from "../src/server/db/schema";
import {
  listTagAdmin,
  mergeTags,
  removeTag,
  renameTag,
  setTagColor,
} from "../src/server/tag-admin";
import { listProjects } from "../src/server/operations";
import { setTicketTags } from "../src/server/operations";
import { tagColorInput, tagMerge, tagRemoval, tagRename, tagStyle } from "../src/domain/tags";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const manager: Principal = {
  id: `tag-manager-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [
    { projectId, actions: ["project.read", "project.manage", "ticket.read", "ticket.note"] },
  ],
};
const reader: Principal = {
  ...manager,
  id: `tag-reader-${projectId}`,
  grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
};
const outsider: Principal = {
  ...manager,
  id: `tag-outsider-${projectId}`,
  grants: [{ projectId: otherProject, actions: ["project.manage"] }],
};
const agent: Principal = { ...manager, kind: "agent" };
const outcomeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof Error && "code" in error ? String(error.code) : "other"),
  );
async function ticket(project: string, tags: string[], junk = false) {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject: "Tags",
      requesterEmail: "kim@example.test",
      requesterName: "Kim",
      language: "en",
      tags,
      junkAt: junk ? new Date() : null,
    })
    .returning({ id: tickets.id });
  return row?.id ?? "";
}
const tagsOf = async (id: string) =>
  (await db().select({ tags: tickets.tags }).from(tickets).where(eq(tickets.id, id)))[0]?.tags;
const reset = async () => {
  await db()
    .delete(tickets)
    .where(inArray(tickets.projectId, [projectId, otherProject]));
  await db().delete(projectTags).where(eq(projectTags.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
};
const auditOf = async (action: string) =>
  (await db().select().from(audit).where(eq(audit.projectId, projectId))).filter(
    (entry) => entry.action === action,
  );
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
  await reset();
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProject]));
  await sqlClient().end();
});
describe("what the inputs accept", () => {
  it("normalizes names like the tags of a ticket, and refuses others", () => {
    expect(tagRename.parse({ from: " Billing ", to: "Money Talk" })).toEqual({
      from: "billing",
      to: "money-talk",
    });
    expect(tagRename.safeParse({ from: "a", to: "b c!" }).success).toBe(false);
    expect(tagRename.safeParse({ from: "a", to: "x".repeat(31) }).success).toBe(false);
    expect(tagMerge.safeParse({ from: ["a", "b"], into: "c" }).success).toBe(true);
    expect(tagMerge.safeParse({ from: ["a", "c"], into: "c" }).success).toBe(false);
    expect(tagMerge.safeParse({ from: ["a", "A"], into: "c" }).success).toBe(false);
    expect(tagMerge.safeParse({ from: [], into: "c" }).success).toBe(false);
    expect(tagColorInput.safeParse({ tag: "a", color: "#A0b1C2" }).success).toBe(true);
    expect(tagColorInput.safeParse({ tag: "a", color: null }).success).toBe(true);
    expect(tagColorInput.safeParse({ tag: "a", color: "red" }).success).toBe(false);
    expect(tagColorInput.safeParse({ tag: "a", color: "#abc" }).success).toBe(false);
    expect(tagRemoval.safeParse({ tag: "a", expectedTickets: -1 }).success).toBe(false);
    expect(tagStyle(undefined, () => "#fff")).toBeUndefined();
    expect(tagStyle("#112233", () => "#fff")).toEqual({
      background: "#112233",
      borderColor: "#112233",
      color: "#fff",
    });
  });
});
describe("listing the tags", () => {
  it("counts the tickets of the project, junk included, with the colour, and not those of another project", async () => {
    await reset();
    await ticket(projectId, ["billing", "urgent"]);
    await ticket(projectId, ["billing"]);
    await ticket(projectId, ["old"], true);
    await ticket(otherProject, ["billing", "foreign"]);
    await setTagColor(manager, projectId, { tag: "billing", color: "#AA0000" });
    await setTagColor(manager, projectId, { tag: "unused", color: "#00AA00" });
    expect(await listTagAdmin(manager, projectId)).toEqual([
      { tag: "billing", tickets: 2, color: "#aa0000" },
      { tag: "old", tickets: 1, color: null },
      { tag: "urgent", tickets: 1, color: null },
      { tag: "unused", tickets: 0, color: "#00aa00" },
    ]);
  });
  it("is for a person who manages the project", async () => {
    for (const call of [
      () => listTagAdmin(reader, projectId),
      () => renameTag(reader, projectId, { from: "a", to: "b" }),
      () => mergeTags(reader, projectId, { from: ["a"], into: "b" }),
      () => setTagColor(reader, projectId, { tag: "a", color: null }),
      () => removeTag(reader, projectId, { tag: "a", expectedTickets: 0 }),
      () => listTagAdmin(outsider, projectId),
    ])
      expect(await outcomeOf(call())).toBe("not_found");
    for (const call of [
      () => listTagAdmin(agent, projectId),
      () => removeTag(agent, projectId, { tag: "a", expectedTickets: 0 }),
      () => listTagAdmin({ ...manager, active: false }, projectId),
    ])
      expect(await outcomeOf(call())).toBe("forbidden");
    await expect(listTagAdmin(manager, "not-an-id")).rejects.toThrow();
  });
});
describe("renaming and merging", () => {
  it("renames a tag in every ticket of the project and keeps the others and the colour", async () => {
    await reset();
    const a = await ticket(projectId, ["billing", "urgent"]);
    const junk = await ticket(projectId, ["billing"], true);
    const other = await ticket(otherProject, ["billing"]);
    await setTagColor(manager, projectId, { tag: "billing", color: "#112233" });
    expect(await renameTag(manager, projectId, { from: "Billing", to: "Money Talk" })).toEqual({
      tickets: 2,
    });
    expect(await tagsOf(a)).toEqual(["money-talk", "urgent"]);
    expect(await tagsOf(junk)).toEqual(["money-talk"]);
    expect(await tagsOf(other)).toEqual(["billing"]);
    expect(
      (await listTagAdmin(manager, projectId)).find((entry) => entry.tag === "money-talk")?.color,
    ).toBe("#112233");
    expect((await listTagAdmin(manager, projectId)).some((entry) => entry.tag === "billing")).toBe(
      false,
    );
    expect((await auditOf("tag.rename"))[0]?.detail).toEqual({
      from: "billing",
      to: "money-talk",
      tickets: 2,
    });
  });
  it("refuses a name in use, a tag that no ticket has and a rename to the same name", async () => {
    await reset();
    await ticket(projectId, ["a", "b"]);
    expect(await outcomeOf(renameTag(manager, projectId, { from: "a", to: "b" }))).toBe("conflict");
    expect(await outcomeOf(renameTag(manager, projectId, { from: "ghost", to: "c" }))).toBe(
      "not_found",
    );
    expect(await outcomeOf(renameTag(manager, projectId, { from: "a", to: "A" }))).toBe(
      "invalid_input",
    );
    expect((await listTagAdmin(manager, projectId)).map((entry) => entry.tag).sort()).toEqual([
      "a",
      "b",
    ]);
  });
  it("merges tags into one, once in a ticket that had several, and moves the colour", async () => {
    await reset();
    const both = await ticket(projectId, ["a", "b", "keep"]);
    const one = await ticket(projectId, ["b"]);
    const target = await ticket(projectId, ["c", "a"]);
    const untouched = await ticket(projectId, ["keep"]);
    await setTagColor(manager, projectId, { tag: "a", color: "#aa0000" });
    await setTagColor(manager, projectId, { tag: "b", color: "#00bb00" });
    expect(await mergeTags(manager, projectId, { from: ["a", "b"], into: "c" })).toEqual({
      tickets: 3,
    });
    expect(await tagsOf(both)).toEqual(["c", "keep"]);
    expect(await tagsOf(one)).toEqual(["c"]);
    expect(await tagsOf(target)).toEqual(["c"]);
    expect(await tagsOf(untouched)).toEqual(["keep"]);
    const listed = await listTagAdmin(manager, projectId);
    expect(listed.find((entry) => entry.tag === "c")).toEqual({
      tag: "c",
      tickets: 3,
      color: "#aa0000",
    });
    expect(listed.some((entry) => entry.tag === "a" || entry.tag === "b")).toBe(false);
    // The colour of the tag that is merged into wins.
    await setTagColor(manager, projectId, { tag: "d", color: "#0000cc" });
    await ticket(projectId, ["d", "e"]);
    await setTagColor(manager, projectId, { tag: "e", color: "#cc0000" });
    await mergeTags(manager, projectId, { from: ["e"], into: "d" });
    expect((await listTagAdmin(manager, projectId)).find((entry) => entry.tag === "d")?.color).toBe(
      "#0000cc",
    );
    // The entries come in no fixed order, and this test made two merges: the one of "a" and "b" is found by its target.
    expect(
      (await auditOf("tag.merge")).find((entry) => entry.detail.into === "c")?.detail,
    ).toMatchObject({
      from: ["a", "b"],
      into: "c",
      tickets: 3,
    });
  });
  it("leaves the revision of a ticket and writes nothing for tags that no ticket has", async () => {
    await reset();
    const id = await ticket(projectId, ["a"]);
    const [before] = await db()
      .select({ revision: tickets.revision })
      .from(tickets)
      .where(eq(tickets.id, id));
    await renameTag(manager, projectId, { from: "a", to: "b" });
    const [after] = await db()
      .select({ revision: tickets.revision })
      .from(tickets)
      .where(eq(tickets.id, id));
    expect(after?.revision).toBe(before?.revision);
    expect(await mergeTags(manager, projectId, { from: ["ghost"], into: "b" })).toEqual({
      tickets: 0,
    });
    expect(await tagsOf(id)).toEqual(["b"]);
  });
  it("still lets a person set the tags of a ticket afterwards", async () => {
    await reset();
    const id = await ticket(projectId, ["a"]);
    await renameTag(manager, projectId, { from: "a", to: "b" });
    expect(await setTicketTags(manager, id, { tags: ["b", "c"] })).toEqual({ tags: ["b", "c"] });
  });
});
describe("colours", () => {
  it("sets, changes and takes away a colour, and sends the colours of a project to the desk", async () => {
    await reset();
    await ticket(projectId, ["billing"]);
    await setTagColor(manager, projectId, { tag: "billing", color: "#112233" });
    await setTagColor(manager, projectId, { tag: "billing", color: "#445566" });
    expect((await listProjects(reader)).find((row) => row.id === projectId)?.tagColors).toEqual({
      billing: "#445566",
    });
    await setTagColor(manager, projectId, { tag: "billing", color: null });
    expect((await listProjects(reader)).find((row) => row.id === projectId)?.tagColors).toEqual({});
    expect((await auditOf("tag.color")).map((entry) => entry.detail)).toEqual(
      expect.arrayContaining([
        { tag: "billing", color: "#445566" },
        { tag: "billing", color: null },
      ]),
    );
  });
});
describe("removing", () => {
  it("removes the tag from all tickets once the number of tickets is named, and drops the colour", async () => {
    await reset();
    const a = await ticket(projectId, ["old", "keep"]);
    const b = await ticket(projectId, ["old"], true);
    await ticket(projectId, ["keep"]);
    await setTagColor(manager, projectId, { tag: "old", color: "#123456" });
    expect(await outcomeOf(removeTag(manager, projectId, { tag: "old", expectedTickets: 1 }))).toBe(
      "stale_version",
    );
    expect(await tagsOf(a)).toEqual(["old", "keep"]);
    expect(await removeTag(manager, projectId, { tag: "old", expectedTickets: 2 })).toEqual({
      tickets: 2,
    });
    expect(await tagsOf(a)).toEqual(["keep"]);
    expect(await tagsOf(b)).toEqual([]);
    expect((await listTagAdmin(manager, projectId)).map((entry) => entry.tag)).toEqual(["keep"]);
    expect((await auditOf("tag.remove"))[0]?.detail).toEqual({ tag: "old", tickets: 2 });
  });
  it("leaves the tickets of other projects alone", async () => {
    await reset();
    const mine = await ticket(projectId, ["x"]);
    const theirs = await ticket(otherProject, ["x"]);
    await removeTag(manager, projectId, { tag: "x", expectedTickets: 1 });
    expect(await tagsOf(mine)).toEqual([]);
    expect(await tagsOf(theirs)).toEqual(["x"]);
  });
});
