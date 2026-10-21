import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, jobs, messages, projects, tickets, user } from "../src/server/db/schema";
import { operatorInfo, reply } from "../src/server/operations";
import { getProfile, setProfile } from "../src/server/profile";
import { signed } from "../src/domain/profile";
import { DomainError } from "../src/server/errors";
import type { Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectId = randomUUID();
const ids = { kim: `profile-kim-${run}`, lee: `profile-lee-${run}`, plain: `profile-plain-${run}` };
const person = (id: string): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: ["project.read", "ticket.read", "ticket.reply", "ticket.note"] }],
});
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof DomainError ? error.code : "other"),
  );
async function ticket() {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Profile",
      requesterEmail: "customer@example.test",
      requesterName: "Customer",
      language: "en",
    })
    .returning();
  if (!row) throw new Error("ticket");
  return row;
}
const body = (revision: number, extra: Record<string, unknown> = {}) => ({
  markdown: "Your order is on its way.",
  internal: false,
  expectedRevision: revision,
  idempotencyKey: randomUUID(),
  language: "en",
  resolve: false,
  ...extra,
});
const sent = async (ticketId: string) =>
  (await db().select().from(messages).where(eq(messages.ticketId, ticketId))).filter(
    (message) => message.authorType === "human",
  );
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values({
      id: projectId,
      name: "Profile",
      slug: `profile-${run}`,
      settings: { outboundConnectionId: randomUUID() },
    });
  await db()
    .insert(user)
    .values(
      Object.entries(ids).map(([name, id]) => ({
        id,
        name: `Account ${name}`,
        email: `${id}@example.test`,
        emailVerified: true,
      })),
    );
});
afterAll(async () => {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  for (const id of Object.values(ids)) {
    await db().delete(audit).where(eq(audit.actorId, id));
    await db().delete(user).where(eq(user.id, id));
  }
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await sqlClient().end();
});
describe("the profile of an operator", () => {
  it("is set and read back, trimmed, and an empty value removes it", async () => {
    expect(await getProfile(person(ids.kim))).toEqual({
      name: "Account kim",
      displayName: null,
      signature: null,
      timeZone: null,
    });
    expect(
      await setProfile(person(ids.kim), {
        displayName: "  Kim Example  ",
        signature: "Kim Example\nSupport team",
      }),
    ).toEqual({
      name: "Account kim",
      displayName: "Kim Example",
      signature: "Kim Example\nSupport team",
      timeZone: null,
    });
    // A field that is left out stays, a field that is empty goes.
    expect(await setProfile(person(ids.kim), { displayName: "" })).toMatchObject({
      displayName: null,
      signature: "Kim Example\nSupport team",
    });
    expect(await setProfile(person(ids.kim), { signature: null })).toMatchObject({
      signature: null,
    });
  });
  it("refuses a text that is too long, a field that is not known, and nothing at all", async () => {
    for (const input of [
      { displayName: "x".repeat(101) },
      { signature: "x".repeat(2001) },
      { displayName: "Kim", admin: true },
      {},
      { displayName: 5 },
    ])
      await expect(setProfile(person(ids.lee), input)).rejects.toThrow();
    expect(await getProfile(person(ids.lee))).toMatchObject({ displayName: null, signature: null });
  });
  it("takes a time zone by itself, refuses what is not one, and null goes back to the zone of the device", async () => {
    expect(await setProfile(person(ids.lee), { timeZone: " Europe/Berlin " })).toMatchObject({
      timeZone: "Europe/Berlin",
      displayName: null,
    });
    expect(await setProfile(person(ids.lee), { displayName: "Lee" })).toMatchObject({
      timeZone: "Europe/Berlin",
      displayName: "Lee",
    });
    for (const bad of ["Mars/Olympus", "CET+9", "", "x".repeat(65), 7])
      await expect(setProfile(person(ids.lee), { timeZone: bad })).rejects.toThrow();
    expect(await getProfile(person(ids.lee))).toMatchObject({ timeZone: "Europe/Berlin" });
    expect(await setProfile(person(ids.lee), { timeZone: null })).toMatchObject({ timeZone: null });
    // The operator information that the desk is made from carries the zone as well.
    await setProfile(person(ids.lee), { timeZone: "Asia/Tokyo" });
    expect(await operatorInfo(person(ids.lee))).toMatchObject({ timeZone: "Asia/Tokyo" });
    expect((await operatorInfo({ ...person(ids.lee), kind: "agent" })).timeZone).toBeNull();
    await db()
      .update(user)
      .set({ displayName: null, signature: null, timeZone: null })
      .where(eq(user.id, ids.lee));
  });
  it("changes only the account of the person who asks", async () => {
    await setProfile(person(ids.lee), { displayName: "Lee", signature: "Lee's signature" });
    expect(await getProfile(person(ids.plain))).toMatchObject({
      displayName: null,
      signature: null,
    });
    await db().update(user).set({ displayName: null, signature: null }).where(eq(user.id, ids.lee));
  });
  it("is for people only", async () => {
    const agent: Principal = { ...person(ids.kim), kind: "agent" };
    expect(await outcome(getProfile(agent))).toBe("forbidden");
    expect(await outcome(setProfile(agent, { displayName: "Agent" }))).toBe("forbidden");
    expect(await outcome(setProfile({ ...person(ids.kim), active: false }, {}))).toBe("forbidden");
  });
  it("is written to the audit with the names of the fields and not their text", async () => {
    await setProfile(person(ids.plain), {
      displayName: "Secret Name",
      signature: "Secret signature",
    });
    const entries = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.actorId, ids.plain), eq(audit.action, "operator.profile")));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toEqual({ fields: ["displayName", "signature"] });
    expect(JSON.stringify(entries)).not.toContain("Secret");
    await db()
      .update(user)
      .set({ displayName: null, signature: null })
      .where(eq(user.id, ids.plain));
  });
});
describe("a reply of an operator", () => {
  it("carries the name and the signature of the person who wrote it, in the mail that is queued", async () => {
    await setProfile(person(ids.kim), {
      displayName: "Kim Example",
      signature: "Kim Example\nSupport team",
    });
    const row = await ticket();
    const result = await reply(person(ids.kim), row.id, body(row.revision));
    const [message] = await sent(row.id);
    expect(message).toMatchObject({
      authorName: "Kim Example",
      markdown: "Your order is on its way.\n\nKim Example\nSupport team",
      deliveryState: "queued",
    });
    const [job] = await db().select().from(jobs).where(eq(jobs.projectId, projectId));
    const queued = (await db().select().from(jobs).where(eq(jobs.projectId, projectId))).find(
      (entry) => entry.payload.messageId === result.id,
    );
    expect(job).toBeDefined();
    expect(queued?.payload.markdown).toBe("Your order is on its way.\n\nKim Example\nSupport team");
  });
  it("is the same reply when it is sent again with the key, and the signature is not added twice", async () => {
    const row = await ticket();
    const input = body(row.revision);
    const first = await reply(person(ids.kim), row.id, input);
    const second = await reply(person(ids.kim), row.id, input);
    expect(second).toMatchObject({ id: first.id, duplicate: true });
    const found = await sent(row.id);
    expect(found).toHaveLength(1);
    expect(found[0]?.markdown.match(/Support team/g)).toHaveLength(1);
  });
  it("is written under the name of the account, and unsigned, when the person set nothing", async () => {
    const row = await ticket();
    await reply(person(ids.plain), row.id, body(row.revision));
    const [message] = await sent(row.id);
    expect(message).toMatchObject({
      authorName: "Account plain",
      markdown: "Your order is on its way.",
    });
  });
  it("does not take the signature of another person", async () => {
    const row = await ticket();
    await reply(person(ids.lee), row.id, body(row.revision));
    const [message] = await sent(row.id);
    expect(message?.markdown).toBe("Your order is on its way.");
    expect(message?.authorName).toBe("Account lee");
  });
  it("carries the name but not the signature on a note, which the customer never reads", async () => {
    const row = await ticket();
    await reply(person(ids.kim), row.id, body(row.revision, { internal: true }));
    const [note] = await sent(row.id);
    expect(note).toMatchObject({
      authorName: "Kim Example",
      markdown: "Your order is on its way.",
      internal: true,
    });
  });
});
describe("the signed text", () => {
  it("ends the text with a blank line and the signature, and leaves it alone without one", () => {
    expect(signed("Text\n\n", "Sig")).toBe("Text\n\nSig");
    expect(signed("Text", null)).toBe("Text");
    expect(signed("Text", "")).toBe("Text");
  });
});
