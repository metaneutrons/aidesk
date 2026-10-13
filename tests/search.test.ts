import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { messages, projects, tickets } from "../src/server/db/schema";
import { searchTickets } from "../src/server/operations";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const marker = `zq${randomUUID().slice(0, 8)}`;
const reader: Principal = {
  id: `reader-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
};
async function ticket(
  fields: {
    subject?: string;
    name?: string;
    email?: string;
    junk?: boolean;
    project?: string;
    updated?: number;
  },
  texts: { markdown: string; internal?: boolean }[] = [],
) {
  const [created] = await db()
    .insert(tickets)
    .values({
      projectId: fields.project ?? projectId,
      subject: fields.subject ?? "Plain subject",
      requesterName: fields.name ?? "Kim Customer",
      requesterEmail: fields.email ?? `kim-${randomUUID().slice(0, 6)}@example.test`,
      language: "en",
      junkAt: fields.junk ? new Date() : null,
      updatedAt: new Date(fields.updated ?? Date.now()),
    })
    .returning({ id: tickets.id });
  const ticketId = created?.id ?? "";
  for (const [index, text] of texts.entries())
    await db()
      .insert(messages)
      .values({
        ticketId,
        authorType: text.internal ? "human" : "customer",
        authorName: "Someone",
        markdown: text.markdown,
        language: "en",
        internal: text.internal === true,
        deliveryState: text.internal ? "internal" : "received",
        createdAt: new Date(Date.now() + index),
      });
  return ticketId;
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Search", slug: `search-${projectId}` },
      { id: otherProject, name: "Other", slug: `search-${otherProject}` },
    ]);
});
afterAll(async () => {
  await db()
    .delete(tickets)
    .where(inArray(tickets.projectId, [projectId, otherProject]));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProject]));
  await sqlClient().end();
});
describe("ticket search", () => {
  it("finds a ticket by subject, requester or any message, ignoring case", async () => {
    const bySubject = await ticket({ subject: `Export ${marker.toUpperCase()} fails` });
    const byName = await ticket({ name: `Alex ${marker.toUpperCase()}son` });
    const byEmail = await ticket({ email: `${marker.toUpperCase()}.person@example.test` });
    const byMessage = await ticket({}, [
      { markdown: "Hello" },
      { markdown: `The error code is ${marker.toUpperCase()}.` },
    ]);
    const byNote = await ticket({}, [
      { markdown: "Private: check the " + marker + " cluster", internal: true },
    ]);
    await ticket({ subject: "Unrelated" }, [{ markdown: "nothing here" }]);
    const found = await searchTickets(reader, marker);
    expect(found.map((entry) => entry.id).sort()).toEqual(
      [bySubject, byName, byEmail, byMessage, byNote].sort(),
    );
    const hit = found.find((entry) => entry.id === byMessage);
    expect(hit?.snippet).toContain(marker.toUpperCase());
    expect(found.find((entry) => entry.id === bySubject)?.snippet).toBeNull();
    // Newest first.
    expect(found.map((entry) => entry.updatedAt.getTime())).toEqual(
      [...found.map((entry) => entry.updatedAt.getTime())].sort((a, b) => b - a),
    );
  });
  it("treats percent, underscore and backslash literally", async () => {
    const literal = await ticket({ subject: `100% done_ok ${marker}\\x` });
    const decoy = await ticket({ subject: `1000 done-ok ${marker}` });
    expect((await searchTickets(reader, "100% done_ok")).map((entry) => entry.id)).toEqual([
      literal,
    ]);
    expect((await searchTickets(reader, `${marker}\\x`)).map((entry) => entry.id)).toEqual([
      literal,
    ]);
    expect((await searchTickets(reader, "%%")).map((entry) => entry.id)).not.toContain(decoy);
    expect((await searchTickets(reader, "__")).map((entry) => entry.id)).not.toContain(decoy);
  });
  it("never matches or reveals tickets of projects the caller may not read", async () => {
    const secret = `secret${marker}`;
    const hidden = await ticket({ subject: secret, project: otherProject }, [{ markdown: secret }]);
    const mine = await ticket({ subject: secret });
    expect((await searchTickets(reader, secret)).map((entry) => entry.id)).toEqual([mine]);
    await expect(searchTickets(reader, secret, [otherProject])).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await searchTickets({ ...reader, grants: [] }, secret)).toEqual([]);
    const both: Principal = {
      ...reader,
      grants: [...reader.grants, { projectId: otherProject, actions: ["ticket.read"] }],
    };
    expect((await searchTickets(both, secret)).map((entry) => entry.id).sort()).toEqual(
      [mine, hidden].sort(),
    );
    expect((await searchTickets(both, secret, [otherProject])).map((entry) => entry.id)).toEqual([
      hidden,
    ]);
    // A project that is only readable, without ticket access, is not searched.
    const noTickets: Principal = { ...reader, grants: [{ projectId, actions: ["project.read"] }] };
    expect(await searchTickets(noTickets, secret)).toEqual([]);
  });
  it("leaves out junk", async () => {
    const word = `junk${marker}`;
    await ticket({ subject: word, junk: true }, [{ markdown: word }]);
    expect(await searchTickets(reader, word)).toEqual([]);
  });
  it("needs a text of a sensible length and returns at most fifty", async () => {
    for (const bad of [undefined, "", " a ", "x".repeat(101), 5])
      await expect(searchTickets(reader, bad)).rejects.toThrow();
    const word = `many${marker}`;
    for (let index = 0; index < 52; index += 1)
      await ticket({ subject: `${word} ${String(index)}` });
    expect(await searchTickets(reader, word)).toHaveLength(50);
    await expect(searchTickets(reader, "ok", ["not-a-uuid"])).rejects.toThrow();
  });
  it("shortens long messages around the hit", async () => {
    const word = `long${marker}`;
    await ticket({}, [{ markdown: `${"before ".repeat(60)}${word} ${"after ".repeat(60)}` }]);
    const [hit] = await searchTickets(reader, word);
    expect(hit?.snippet?.startsWith("…")).toBe(true);
    expect(hit?.snippet?.endsWith("…")).toBe(true);
    expect(hit?.snippet).toContain(word);
    expect(hit?.snippet?.length).toBeLessThan(180);
  });
});
