import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { projects, savedViews, user } from "../src/server/db/schema";
import { createView, deleteView, listViews, setStartView, updateView } from "../src/server/views";
import { maxViews, viewCreate, viewUpdate } from "../src/domain/views";
import type { Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const first = randomUUID();
const second = randomUUID();
const foreign = randomUUID();
const kim = `views-kim-${run}`;
const lee = `views-lee-${run}`;
const principal = (id: string, readable: string[] = [first, second]): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: readable.map((projectId) => ({ projectId, actions: ["project.read", "ticket.read"] })),
});
const input = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  list: "inbox",
  projects: [],
  tag: null,
  priority: null,
  category: null,
  ...extra,
});
const names = async (who: Principal) => (await listViews(who)).views.map((view) => view.name);
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values(
      [first, second, foreign].map((id, index) => ({
        id,
        name: `Views ${String(index)}`,
        slug: `views-${String(index)}-${run}`,
      })),
    );
  await db()
    .insert(user)
    .values(
      [kim, lee].map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true })),
    );
}, 60_000);
afterAll(async () => {
  await db()
    .delete(user)
    .where(inArray(user.id, [kim, lee]));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [first, second, foreign]));
  await sqlClient().end();
});
describe("saving the filters as a view", () => {
  it("keeps the name, the list and the filters, trims what it is given and lists the views by name in any case", async () => {
    await db().delete(savedViews).where(eq(savedViews.userId, kim));
    await createView(
      principal(kim),
      input("  zebra  ", {
        list: "overdue",
        projects: [first, first],
        tag: " vip ",
        priority: "urgent",
        category: "",
      }),
    );
    await createView(principal(kim), input("Apple"));
    const { views } = await listViews(principal(kim));
    expect(views.map((view) => view.name)).toEqual(["Apple", "zebra"]);
    expect(views[1]).toMatchObject({
      list: "overdue",
      projects: [first],
      tag: "vip",
      priority: "urgent",
      category: null,
      restricted: false,
      start: false,
    });
    expect(views[0]).toMatchObject({ list: "inbox", projects: [], restricted: false });
  });
  it("uses a name once for a person, in any case, and lets another person use it", async () => {
    await db()
      .delete(savedViews)
      .where(inArray(savedViews.userId, [kim, lee]));
    await createView(principal(kim), input("Mine"));
    await expect(createView(principal(kim), input("mine"))).rejects.toMatchObject({
      code: "conflict",
    });
    await createView(principal(lee), input("Mine"));
    expect(await names(principal(lee))).toEqual(["Mine"]);
    expect(await names(principal(kim))).toEqual(["Mine"]);
  });
  it("refuses a project that the person may not read, an unknown filter and more than the limit", async () => {
    await db().delete(savedViews).where(eq(savedViews.userId, kim));
    await expect(
      createView(principal(kim), input("Elsewhere", { projects: [foreign] })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createView(principal(kim), input("Nowhere", { projects: [randomUUID()] })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    for (const bad of [
      input("X", { list: "settings" }),
      input("X", { priority: "later" }),
      input("X", { projects: ["not-an-id"] }),
      input("   "),
      input("x".repeat(61)),
      { ...input("X"), admin: true },
    ])
      expect(viewCreate.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    for (let index = 0; index < maxViews; index += 1)
      await createView(principal(kim), input(`View ${String(index)}`));
    await expect(createView(principal(kim), input("One too many"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await listViews(principal(kim))).views).toHaveLength(maxViews);
    await db().delete(savedViews).where(eq(savedViews.userId, kim));
  });
  it("is for people only", async () => {
    for (const bad of [
      { ...principal(kim), kind: "agent" as const },
      { ...principal(kim), active: false },
    ]) {
      await expect(listViews(bad)).rejects.toMatchObject({ code: "forbidden" });
      await expect(createView(bad, input("X"))).rejects.toMatchObject({ code: "forbidden" });
    }
  });
});
describe("a view and the grants", () => {
  it("shows only the projects that the person may read now, and is not applied when none is left", async () => {
    await db().delete(savedViews).where(eq(savedViews.userId, kim));
    await createView(principal(kim), input("Two", { projects: [first, second] }));
    await createView(principal(kim), input("Everything"));
    const view = (who: Principal, name: string) =>
      listViews(who).then((all) => all.views.find((entry) => entry.name === name));
    expect(await view(principal(kim), "Two")).toMatchObject({
      projects: [first, second],
      restricted: false,
    });
    // One project is no longer readable: the view keeps the other.
    expect(await view(principal(kim, [second]), "Two")).toMatchObject({
      projects: [second],
      restricted: false,
    });
    // No project is readable: nothing is shown and the view says so; it is not widened to everything.
    expect(await view(principal(kim, []), "Two")).toMatchObject({ projects: [], restricted: true });
    // A view of no projects is all that the person may read, however few.
    expect(await view(principal(kim, []), "Everything")).toMatchObject({
      projects: [],
      restricted: false,
    });
    // What was stored is left alone, so that the view works again when the access comes back.
    expect(await view(principal(kim), "Two")).toMatchObject({ projects: [first, second] });
  });
});
describe("changing, deleting and starting with a view", () => {
  it("changes some fields and leaves the others, refuses a name that is taken and an empty change", async () => {
    await db().delete(savedViews).where(eq(savedViews.userId, kim));
    await createView(
      principal(kim),
      input("One", { list: "waiting", tag: "vip", projects: [first] }),
    );
    await createView(principal(kim), input("Two"));
    const id =
      (await listViews(principal(kim))).views.find((view) => view.name === "One")?.id ?? "";
    await updateView(principal(kim), id, { priority: "high", tag: null });
    const changed = (await listViews(principal(kim))).views.find((view) => view.id === id);
    expect(changed).toMatchObject({
      list: "waiting",
      projects: [first],
      tag: null,
      priority: "high",
      name: "One",
    });
    await updateView(principal(kim), id, { name: "Renamed" });
    expect(await names(principal(kim))).toEqual(["Renamed", "Two"]);
    await expect(updateView(principal(kim), id, { name: "two" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(updateView(principal(kim), id, { projects: [foreign] })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(viewUpdate.safeParse({}).success).toBe(false);
    await expect(updateView(principal(kim), id, {})).rejects.toThrow();
  });
  it("is the view of its own person only", async () => {
    await db()
      .delete(savedViews)
      .where(inArray(savedViews.userId, [kim, lee]));
    await createView(principal(kim), input("Kim's"));
    const id = (await listViews(principal(kim))).views[0]?.id ?? "";
    await expect(updateView(principal(lee), id, { name: "Stolen" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(deleteView(principal(lee), id)).rejects.toMatchObject({ code: "not_found" });
    await expect(setStartView(principal(lee), id, { start: true })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(deleteView(principal(kim), randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await names(principal(kim))).toEqual(["Kim's"]);
    await deleteView(principal(kim), id);
    expect(await names(principal(kim))).toEqual([]);
  });
  it("opens the desk with one view at most, and taking it away leaves none", async () => {
    await db()
      .delete(savedViews)
      .where(inArray(savedViews.userId, [kim, lee]));
    await createView(principal(kim), input("A"));
    await createView(principal(kim), input("B"));
    await createView(principal(lee), input("A"));
    const ids = Object.fromEntries(
      (await listViews(principal(kim))).views.map((view) => [view.name, view.id]),
    );
    const leeId = (await listViews(principal(lee))).views[0]?.id ?? "";
    await setStartView(principal(lee), leeId, { start: true });
    const starts = async () =>
      (await listViews(principal(kim))).views.filter((view) => view.start).map((view) => view.name);
    await setStartView(principal(kim), ids.A ?? "", { start: true });
    expect(await starts()).toEqual(["A"]);
    await setStartView(principal(kim), ids.B ?? "", { start: true });
    expect(await starts()).toEqual(["B"]);
    // Another person's start is not touched.
    expect((await listViews(principal(lee))).views[0]?.start).toBe(true);
    await setStartView(principal(kim), ids.B ?? "", { start: false });
    expect(await starts()).toEqual([]);
    await expect(setStartView(principal(kim), ids.A ?? "", { start: "yes" })).rejects.toThrow();
  });
});
