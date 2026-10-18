import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ZodError } from "zod";
import { db } from "../src/server/db";
import { audit, session, user, workspaceSettings } from "../src/server/db/schema";
import { auth } from "../src/server/auth";
import { getLimits, readLimits, setLimits, useLimitsKey } from "../src/server/limits";
import { limitBounds, limitDefaults, limitKeys, limitsInput } from "../src/domain/limits";
import { DomainError } from "../src/server/errors";
import type { Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const key = `limits-test-${run}`;
const owner: Principal = {
  id: `owner-${run}`,
  kind: "human",
  active: true,
  owner: true,
  grants: [],
};
const operator: Principal = { ...owner, id: `operator-${run}`, owner: false };
const token: Principal = { ...owner, id: `token-${run}`, kind: "agent" };
const userId = `limits-user-${run}`;
const outcome = async (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) =>
      error instanceof DomainError ? error.code : error instanceof ZodError ? "invalid" : "other",
  );
const row = async () => {
  const [found] = await db().select().from(workspaceSettings).where(eq(workspaceSettings.key, key));
  return found;
};
const entries = () =>
  db()
    .select({ detail: audit.detail, actorId: audit.actorId })
    .from(audit)
    .where(
      and(
        isNull(audit.projectId),
        eq(audit.action, "workspace.limits"),
        eq(audit.actorId, owner.id),
      ),
    );
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  useLimitsKey(key);
  await db()
    .insert(user)
    .values({ id: userId, name: "Limits user", email: `${userId}@example.test` });
});
afterAll(async () => {
  await db().delete(workspaceSettings).where(eq(workspaceSettings.key, key));
  await db()
    .delete(audit)
    .where(inArray(audit.actorId, [owner.id]));
  await db().delete(session).where(eq(session.userId, userId));
  await db().delete(user).where(eq(user.id, userId));
  useLimitsKey("limits");
});
describe("the limits of the workspace", () => {
  it("are the old constants until an owner changes them", async () => {
    expect(await getLimits()).toEqual(limitDefaults);
    expect(limitDefaults).toEqual({
      intakeFiles: 25,
      intakeFileMiB: 15,
      portalFiles: 10,
      portalTotalMiB: 30,
      sessionHours: 12,
      portalLinkDays: 30,
    });
  });
  it("are read and set by the owner only, and a token or an operator is refused", async () => {
    expect(await outcome(readLimits(operator))).toBe("forbidden");
    expect(await outcome(readLimits(token))).toBe("forbidden");
    expect(await outcome(setLimits(operator, { intakeFiles: 5 }))).toBe("forbidden");
    expect(await outcome(setLimits(token, { intakeFiles: 5 }))).toBe("forbidden");
    expect(await outcome(setLimits({ ...owner, active: false }, { intakeFiles: 5 }))).toBe(
      "forbidden",
    );
    expect(await row()).toBeUndefined();
    expect(await readLimits(owner)).toEqual(limitDefaults);
  });
  it("change one value and leave the others, and say so in the audit", async () => {
    const after = await setLimits(owner, { intakeFiles: 5 });
    expect(after).toEqual({ ...limitDefaults, intakeFiles: 5 });
    expect(await getLimits()).toEqual(after);
    const written = await entries();
    expect(written).toHaveLength(1);
    expect(written[0]?.detail).toEqual({ changed: { intakeFiles: { from: 25, to: 5 } } });
    const second = await setLimits(owner, { sessionHours: 48, portalLinkDays: 7 });
    expect(second).toEqual({
      ...limitDefaults,
      intakeFiles: 5,
      sessionHours: 48,
      portalLinkDays: 7,
    });
    expect((await entries()).at(-1)?.detail).toEqual({
      changed: { sessionHours: { from: 12, to: 48 }, portalLinkDays: { from: 30, to: 7 } },
    });
  });
  it("write nothing and no audit entry when nothing changes", async () => {
    const before = (await entries()).length;
    await setLimits(owner, { intakeFiles: 5 });
    expect((await entries()).length).toBe(before);
  });
  it("keep a value that equals the default as it is stored", async () => {
    await setLimits(owner, { intakeFiles: 25 });
    expect((await row())?.value).toMatchObject({ intakeFiles: 25 });
  });
  it("refuse a value outside its bounds, a fraction, a text, an unknown name and an empty request", async () => {
    for (const key of limitKeys) {
      const [low, high] = limitBounds[key];
      expect(await outcome(setLimits(owner, { [key]: low - 1 })), `${key} below`).toBe("invalid");
      expect(await outcome(setLimits(owner, { [key]: high + 1 })), `${key} above`).toBe("invalid");
      expect(await outcome(setLimits(owner, { [key]: low + 0.5 })), `${key} fraction`).toBe(
        "invalid",
      );
      expect(await outcome(setLimits(owner, { [key]: String(low) })), `${key} text`).toBe(
        "invalid",
      );
      expect(limitsInput.safeParse({ [key]: low }).success, `${key} low`).toBe(true);
      expect(limitsInput.safeParse({ [key]: high }).success, `${key} high`).toBe(true);
    }
    expect(await outcome(setLimits(owner, { somethingElse: 3 }))).toBe("invalid");
    expect(await outcome(setLimits(owner, {}))).toBe("invalid");
  });
  it("never open a limit when the stored row is damaged", async () => {
    await db()
      .update(workspaceSettings)
      .set({
        value: {
          intakeFiles: -3,
          intakeFileMiB: 9999,
          portalFiles: "ten",
          portalTotalMiB: 2.5,
          sessionHours: null,
          portalLinkDays: 365,
        },
      })
      .where(eq(workspaceSettings.key, key));
    expect(await getLimits()).toEqual(limitDefaults);
    await db()
      .update(workspaceSettings)
      .set({ value: { intakeFiles: 7, portalFiles: "ten" } })
      .where(eq(workspaceSettings.key, key));
    expect(await getLimits()).toEqual({ ...limitDefaults, intakeFiles: 7 });
  });
});
describe("the length of a session", () => {
  const start = async () => {
    const context = await auth().$context;
    const started = await context.internalAdapter.createSession(userId);
    return started.expiresAt.getTime() - Date.now();
  };
  const near = (milliseconds: number, hours: number) =>
    Math.abs(milliseconds - hours * 3_600_000) < 60_000;
  it("follows the limit at the moment that it starts, and an earlier session keeps its end", async () => {
    await db().update(workspaceSettings).set({ value: {} }).where(eq(workspaceSettings.key, key));
    expect(near(await start(), 12)).toBe(true);
    await setLimits(owner, { sessionHours: 2 });
    expect(near(await start(), 2)).toBe(true);
    await setLimits(owner, { sessionHours: 48 });
    expect(near(await start(), 48)).toBe(true);
    const lengths = (
      await db().select({ end: session.expiresAt }).from(session).where(eq(session.userId, userId))
    )
      .map((found) => Math.round((found.end.getTime() - Date.now()) / 3_600_000))
      .sort((a, b) => a - b);
    // Three sessions with three different ends: the later changes did not move the earlier ones.
    expect(lengths).toEqual([2, 12, 48]);
  });
  it("is never longer than the cookie that carries it, at the highest value", async () => {
    await setLimits(owner, { sessionHours: limitBounds.sessionHours[1] });
    expect(near(await start(), 720)).toBe(true);
    const context = await auth().$context;
    expect(context.sessionConfig.expiresIn).toBe(720 * 3600);
  });
  it("is not extended by use: a request with the cookie leaves the end where it was", async () => {
    await setLimits(owner, { sessionHours: 3 });
    const context = await auth().$context;
    const started = await context.internalAdapter.createSession(userId);
    // The cookie of a session is its token and a signature that only the server can make.
    const signature = createHmac("sha256", context.secret).update(started.token).digest("base64");
    const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${started.token}.${signature}`)}`;
    const answered = await auth().api.getSession({ headers: new Headers({ cookie }) });
    // The request was understood as this session; without that the test would show nothing.
    expect(answered?.session.token).toBe(started.token);
    const [stored] = await db()
      .select({ end: session.expiresAt })
      .from(session)
      .where(eq(session.token, started.token));
    expect(stored?.end.getTime()).toBe(started.expiresAt.getTime());
    expect(answered?.session.expiresAt.getTime()).toBe(started.expiresAt.getTime());
  });
});
