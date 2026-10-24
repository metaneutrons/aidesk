import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { connections, projects, workspaceSettings } from "../src/server/db/schema";
import { claimSlot } from "../src/server/schedule";
// The limit of periodic work holds for every process: a platform that starts a new process for each call must not
// poll the mailboxes or scan the clock more often than a worker that lives long.
const run = randomUUID().slice(0, 8);
const name = (part: string) => `test-${run}-${part}`;
const projectId = randomUUID();
const keyOf = (part: string) => `schedule:${name(part)}`;
const moveBack = (part: string, ms: number) =>
  db()
    .update(workspaceSettings)
    .set({ value: { at: Date.now() - ms } })
    .where(eq(workspaceSettings.key, keyOf(part)));
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values({ id: projectId, name: "Schedule", slug: `schedule-${projectId}` });
});
afterAll(async () => {
  await db().delete(connections).where(eq(connections.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await db()
    .delete(workspaceSettings)
    .where(like(workspaceSettings.key, `schedule:test-${run}-%`));
  await db().delete(workspaceSettings).where(eq(workspaceSettings.key, "schedule:mailboxes"));
  await sqlClient().end();
});
describe("the slot of a periodic job", () => {
  it("is given once and not again until the interval is over", async () => {
    expect(await claimSlot(name("once"), 60_000)).toBe(true);
    expect(await claimSlot(name("once"), 60_000)).toBe(false);
    await moveBack("once", 61_000);
    expect(await claimSlot(name("once"), 60_000)).toBe(true);
  });
  it("opens a little before the interval is over, for calls that differ by milliseconds", async () => {
    expect(await claimSlot(name("grace"), 60_000)).toBe(true);
    // A tenth of the interval, at most five seconds: 55 seconds are enough, 50 are not.
    await moveBack("grace", 50_000);
    expect(await claimSlot(name("grace"), 60_000)).toBe(false);
    await moveBack("grace", 56_000);
    expect(await claimSlot(name("grace"), 60_000)).toBe(true);
  });
  it("goes to one of several calls at the same moment", async () => {
    const answers = await Promise.all(
      Array.from({ length: 12 }, () => claimSlot(name("race"), 60_000)),
    );
    expect(answers.filter(Boolean)).toHaveLength(1);
  });
  it("is kept for each name", async () => {
    expect(await claimSlot(name("a"), 60_000)).toBe(true);
    expect(await claimSlot(name("b"), 60_000)).toBe(true);
    expect(await claimSlot(name("a"), 60_000)).toBe(false);
  });
});
describe("polling the mailboxes", () => {
  it("polls a mailbox once per interval even when a new process makes each call", async () => {
    await db().delete(workspaceSettings).where(eq(workspaceSettings.key, "schedule:mailboxes"));
    await db().insert(connections).values({
      projectId,
      kind: "imap",
      name: "Mailbox",
      direction: "inbound",
      status: "ready",
      config: {},
    });
    const calls: string[] = [];
    const pollers = {
      imap: (id: string) => {
        calls.push(id);
        return Promise.resolve({ fetched: 0 });
      },
      cloudflare: () => Promise.resolve({}),
    };
    // A call of a platform: a module that has just been loaded, with no memory of earlier calls.
    const freshCall = async () => {
      vi.resetModules();
      const jobs = await import("../src/worker/jobs");
      await jobs.pollMailboxes(pollers);
    };
    await freshCall();
    const first = calls.filter((id) => id !== "").length;
    await freshCall();
    await freshCall();
    // The mailboxes of other projects may be polled too; the one of this test is polled once.
    expect(first).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBe(first);
    // After the interval it is polled again.
    await db()
      .update(workspaceSettings)
      .set({ value: { at: Date.now() - 120_000 } })
      .where(eq(workspaceSettings.key, "schedule:mailboxes"));
    await freshCall();
    expect(calls.length).toBe(first * 2);
  });
});
