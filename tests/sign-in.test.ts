import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { account, audit, passkey, session, twoFactor, user } from "../src/server/db/schema";
import { endOtherSessions, endSession, getSignIn, listSessions } from "../src/server/sign-in";
import type { Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const owner = `signin-owner-${run}`;
const member = `signin-member-${run}`;
const other = `signin-other-${run}`;
const people = [owner, member, other];
const principal = (id: string): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: [],
});
const live = (userId: string, id: string, agent = "Firefox on Linux", hours = 5) =>
  db()
    .insert(session)
    .values({
      id,
      userId,
      token: `token-${id}`,
      expiresAt: new Date(Date.now() + hours * 3_600_000),
      userAgent: agent,
      ipAddress: "192.0.2.7",
    });
const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
const sessionsOf = (userId: string) =>
  db().select({ id: session.id }).from(session).where(eq(session.userId, userId));
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(user)
    .values(
      people.map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true })),
    );
  await db()
    .insert(account)
    .values([
      {
        id: `acc-1-${run}`,
        accountId: owner,
        providerId: "credential",
        userId: owner,
        password: "x",
      },
      { id: `acc-2-${run}`, accountId: member, providerId: `idp-b-${run}`, userId: member },
      { id: `acc-3-${run}`, accountId: member, providerId: `idp-a-${run}`, userId: member },
    ]);
  await db()
    .insert(twoFactor)
    .values({ id: `tf-${run}`, secret: "s", backupCodes: "b", userId: owner, verified: true });
  await db()
    .insert(passkey)
    .values(
      [1, 2].map((index) => ({
        id: `pk-${String(index)}-${run}`,
        userId: owner,
        publicKey: "k",
        credentialID: `c-${String(index)}-${run}`,
        counter: 0,
        deviceType: "multiDevice",
        backedUp: true,
      })),
    );
}, 60_000);
afterAll(async () => {
  await db().delete(audit).where(inArray(audit.actorId, people));
  await db().delete(user).where(inArray(user.id, people));
  await sqlClient().end();
});
describe("how the account can be signed in to", () => {
  it("names the password, the authenticator app, the passkeys and the identity providers of the account only", async () => {
    expect(await getSignIn(principal(owner))).toEqual({
      password: true,
      codes: true,
      passkeys: 2,
      providers: [],
    });
    expect(await getSignIn(principal(member))).toEqual({
      password: false,
      codes: false,
      passkeys: 0,
      providers: [`idp-a-${run}`, `idp-b-${run}`],
    });
    expect(await getSignIn(principal(other))).toEqual({
      password: false,
      codes: false,
      passkeys: 0,
      providers: [],
    });
  });
  it("does not count an authenticator app that was never confirmed", async () => {
    await db().update(twoFactor).set({ verified: false }).where(eq(twoFactor.userId, owner));
    expect((await getSignIn(principal(owner))).codes).toBe(false);
    await db().update(twoFactor).set({ verified: true }).where(eq(twoFactor.userId, owner));
  });
  it("is for people who are active, not for agents", async () => {
    for (const bad of [
      { ...principal(owner), kind: "agent" as const },
      { ...principal(owner), active: false },
    ]) {
      await expect(getSignIn(bad)).rejects.toMatchObject({ code: "forbidden" });
      await expect(listSessions(bad, null)).rejects.toMatchObject({ code: "forbidden" });
      await expect(endSession(bad, null, "x")).rejects.toMatchObject({ code: "forbidden" });
      await expect(endOtherSessions(bad, null)).rejects.toMatchObject({ code: "forbidden" });
    }
  });
});
describe("the open sessions", () => {
  it("lists the live sessions of the person, newest first, marks the current one and cuts a long browser name", async () => {
    await db().delete(session).where(inArray(session.userId, people));
    await live(owner, `s1-${run}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await live(owner, `s2-${run}`, "x".repeat(500));
    await live(owner, `s3-${run}`, "Expired", -1);
    await live(other, `s4-${run}`);
    const list = (await listSessions(principal(owner), `s1-${run}`)).sessions;
    expect(list.map((entry) => entry.id)).toEqual([`s2-${run}`, `s1-${run}`]);
    expect(list.map((entry) => entry.current)).toEqual([false, true]);
    expect(list[0]?.userAgent).toHaveLength(200);
    expect(list[1]).toMatchObject({ userAgent: "Firefox on Linux", ipAddress: "192.0.2.7" });
    // Without a current session nothing is marked.
    expect(
      (await listSessions(principal(owner), null)).sessions.every((entry) => !entry.current),
    ).toBe(true);
  });
  it("ends another session of the person and writes an entry of the audit without the device", async () => {
    await db().delete(session).where(inArray(session.userId, people));
    await live(owner, `a1-${run}`);
    await live(owner, `a2-${run}`);
    await db().delete(audit).where(eq(audit.actorId, owner));
    expect(await endSession(principal(owner), `a1-${run}`, `a2-${run}`)).toEqual({ ended: 1 });
    expect(ids(await sessionsOf(owner))).toEqual([`a1-${run}`]);
    const entries = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.actorId, owner), eq(audit.action, "operator.session_end")));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toEqual({ scope: "one", count: 1 });
    expect(JSON.stringify(entries)).not.toContain("Firefox");
  });
  it("does not end the session that asks, the session of another person, or one that does not exist", async () => {
    await db().delete(session).where(inArray(session.userId, people));
    await live(owner, `b1-${run}`);
    await live(other, `b2-${run}`);
    await expect(endSession(principal(owner), `b1-${run}`, `b1-${run}`)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(endSession(principal(owner), `b1-${run}`, `b2-${run}`)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(endSession(principal(owner), `b1-${run}`, "nothing")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(ids(await sessionsOf(owner))).toEqual([`b1-${run}`]);
    expect(ids(await sessionsOf(other))).toEqual([`b2-${run}`]);
  });
  it("ends every other session of the person and none of anybody else's", async () => {
    await db().delete(session).where(inArray(session.userId, people));
    for (const id of ["c1", "c2", "c3"]) await live(owner, `${id}-${run}`);
    await live(other, `c4-${run}`);
    await db().delete(audit).where(eq(audit.actorId, owner));
    expect(await endOtherSessions(principal(owner), `c2-${run}`)).toEqual({ ended: 2 });
    expect(ids(await sessionsOf(owner))).toEqual([`c2-${run}`]);
    expect(ids(await sessionsOf(other))).toEqual([`c4-${run}`]);
    // Nothing to end writes nothing.
    expect(await endOtherSessions(principal(owner), `c2-${run}`)).toEqual({ ended: 0 });
    const entries = await db()
      .select()
      .from(audit)
      .where(and(eq(audit.actorId, owner), eq(audit.action, "operator.session_end")));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.detail).toEqual({ scope: "others", count: 2 });
  });
  it("ends every session of the person when the request has no session of its own", async () => {
    await db().delete(session).where(inArray(session.userId, people));
    await live(owner, `d1-${run}`);
    expect(await endOtherSessions(principal(owner), null)).toEqual({ ended: 1 });
    expect(await sessionsOf(owner)).toEqual([]);
  });
});
