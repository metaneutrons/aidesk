import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  aiBudgets,
  aiProfiles,
  aiRuns,
  attachments,
  connections,
  messages,
  projects,
  tickets,
} from "../src/server/db/schema";
import { getUsage } from "../src/server/usage";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
import { DomainError } from "../src/server/errors";
import type { Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectA = randomUUID();
const projectB = randomUUID();
// The principals are built here, not read from the table of users (see the tests of the deletion of a project).
const reader = (project: string, actions: Principal["grants"][number]["actions"]): Principal => ({
  id: `usage-reader-${run}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId: project, actions }],
});
const allowed = reader(projectA, ["project.read", "config.read"]);
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const label = (date: Date) => date.toISOString().slice(0, 10);
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof DomainError ? error.code : "other"),
  );
async function ticketOf(project: string, subject: string) {
  const [ticket] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject,
      requesterEmail: `customer-${run}@example.test`,
      requesterName: "Customer",
    })
    .returning();
  if (!ticket) throw new Error("ticket");
  return ticket.id;
}
const message = (ticketId: string, at: Date, fields: Partial<typeof messages.$inferInsert> = {}) =>
  db()
    .insert(messages)
    .values({
      ticketId,
      authorType: "customer",
      authorName: "Customer",
      markdown: "text",
      deliveryState: "received",
      createdAt: at,
      ...fields,
    })
    .returning();
const aiRun = (project: string, at: Date, fields: Partial<typeof aiRuns.$inferInsert> = {}) =>
  db()
    .insert(aiRuns)
    .values({
      projectId: project,
      task: "reply.draft",
      outcome: "ok",
      inputTokens: 100,
      outputTokens: 20,
      durationMs: 5,
      actorKind: "human",
      actorId: "operator",
      createdAt: at,
      ...fields,
    });
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectA, name: "Usage A", slug: `usage-a-${run}` },
      { id: projectB, name: "Usage B", slug: `usage-b-${run}` },
    ]);
  const [connection] = await db()
    .insert(connections)
    .values({
      projectId: projectA,
      kind: "anthropic",
      direction: "ai",
      name: "provider",
      status: "ready",
      config: {},
      secretCiphertext: seal(JSON.stringify({ apiKey: "sk-usage" }), env().ENCRYPTION_KEY),
    })
    .returning({ id: connections.id });
  await db()
    .insert(aiProfiles)
    .values({
      projectId: projectA,
      task: "reply.draft",
      connectionId: connection?.id ?? "",
      model: "model-one",
      timeoutSeconds: 20,
      maxOutputTokens: 500,
      dailyTokenBudget: 10_000,
      enabled: true,
    });
  // Today: two runs that worked, one that failed; yesterday: one run; ten days ago: one run (outside a week).
  await aiRun(projectA, daysAgo(0));
  await aiRun(projectA, daysAgo(0), { inputTokens: 50, outputTokens: 10 });
  await aiRun(projectA, daysAgo(0), {
    outcome: "provider_unavailable",
    inputTokens: null,
    outputTokens: null,
  });
  await aiRun(projectA, daysAgo(0), { task: "ticket.summarize", inputTokens: 7, outputTokens: 3 });
  await aiRun(projectA, daysAgo(1));
  await aiRun(projectA, daysAgo(10), { inputTokens: 999, outputTokens: 999 });
  await aiRun(projectB, daysAgo(0), { inputTokens: 5000, outputTokens: 5000 });
  await db()
    .insert(aiBudgets)
    .values([
      { projectId: projectA, task: "reply.draft", day: label(daysAgo(0)), charged: 2500 },
      { projectId: projectA, task: "reply.draft", day: label(daysAgo(1)), charged: 12_000 },
      { projectId: projectA, task: "reply.draft", day: label(daysAgo(10)), charged: 1 },
      { projectId: projectB, task: "reply.draft", day: label(daysAgo(0)), charged: 777 },
    ]);
  const ticketA = await ticketOf(projectA, "A");
  const ticketB = await ticketOf(projectB, "B");
  await message(ticketA, daysAgo(0));
  await message(ticketA, daysAgo(0));
  await message(ticketA, daysAgo(0), {
    authorType: "agent",
    authorName: "Agent",
    deliveryState: "sent",
  });
  await message(ticketA, daysAgo(0), {
    authorType: "agent",
    authorName: "Agent",
    deliveryState: "queued",
  });
  await message(ticketA, daysAgo(0), {
    authorType: "agent",
    authorName: "Agent",
    deliveryState: "sent",
    internal: true,
  });
  await message(ticketA, daysAgo(1), {
    authorType: "operator",
    authorName: "Op",
    deliveryState: "sent",
  });
  await message(ticketA, daysAgo(10));
  await message(ticketB, daysAgo(0));
  const [withRaw] = await message(ticketA, daysAgo(2), {
    rawObjectKey: `inbound/${projectA}/${"e".repeat(64)}.eml`,
  });
  const [otherMessage] = await message(ticketB, daysAgo(2), {
    rawObjectKey: `inbound/${projectB}/${"f".repeat(64)}.eml`,
  });
  if (!withRaw || !otherMessage) throw new Error("message");
  const file = (
    messageId: string,
    project: string,
    position: number,
    size: number,
    stored: boolean,
  ) => ({
    messageId,
    projectId: project,
    position,
    filename: `file-${String(position)}.bin`,
    contentType: "application/octet-stream",
    size,
    checksum: `c${String(position)}${project}`.slice(0, 64),
    objectKey: stored ? `attachments/${project}/${String(position)}${"0".repeat(63)}` : null,
    refusal: stored ? null : "too_large",
  });
  await db()
    .insert(attachments)
    .values([
      file(withRaw.id, projectA, 0, 1000, true),
      file(withRaw.id, projectA, 1, 234, true),
      file(withRaw.id, projectA, 2, 500_000, false),
      file(otherMessage.id, projectB, 0, 70_000, true),
    ]);
});
afterAll(async () => {
  await db().delete(tickets).where(eq(tickets.projectId, projectA));
  await db().delete(tickets).where(eq(tickets.projectId, projectB));
  await db().delete(projects).where(eq(projects.id, projectA));
  await db().delete(projects).where(eq(projects.id, projectB));
  await sqlClient().end();
});
describe("the use of the AI", () => {
  it("counts the calls of a day and a task with their outcomes and tokens", async () => {
    const usage = await getUsage(allowed, projectA, { days: "14" });
    const today = usage.ai.find(
      (cell) => cell.day === label(daysAgo(0)) && cell.task === "reply.draft",
    );
    expect(today).toMatchObject({
      calls: 3,
      outcomes: { ok: 2, provider_unavailable: 1 },
      inputTokens: 150,
      outputTokens: 30,
    });
    const summary = usage.ai.find(
      (cell) => cell.day === label(daysAgo(0)) && cell.task === "ticket.summarize",
    );
    expect(summary).toMatchObject({ calls: 1, inputTokens: 7, outputTokens: 3 });
  });
  it("shows what was charged against the budget and what is left of it, never below zero", async () => {
    const usage = await getUsage(allowed, projectA, { days: "14" });
    const today = usage.ai.find(
      (cell) => cell.day === label(daysAgo(0)) && cell.task === "reply.draft",
    );
    expect(today).toMatchObject({ charged: 2500, budget: 10_000, left: 7500 });
    const yesterday = usage.ai.find((cell) => cell.day === label(daysAgo(1)));
    expect(yesterday).toMatchObject({ charged: 12_000, budget: 10_000, left: 0 });
    // A task without a profile has no budget to show.
    const summary = usage.ai.find((cell) => cell.task === "ticket.summarize");
    expect(summary).toMatchObject({ charged: 0, budget: null, left: null });
  });
  it("lists the newest day first", async () => {
    const usage = await getUsage(allowed, projectA, { days: "14" });
    const days = usage.ai.map((cell) => cell.day);
    expect(days).toEqual([...days].sort().reverse());
  });
});
describe("the window", () => {
  it("leaves out what is older than the days asked for, in the AI, the budget and the mail", async () => {
    const week = await getUsage(allowed, projectA, { days: "7" });
    expect(week.ai.some((cell) => cell.day === label(daysAgo(10)))).toBe(false);
    expect(week.ai.reduce((sum, cell) => sum + cell.inputTokens, 0)).toBe(100 + 50 + 7 + 100);
    expect(week.mail.some((row) => row.day === label(daysAgo(10)))).toBe(false);
    expect(week.from).toBe(label(daysAgo(6)));
    expect(week.to).toBe(label(daysAgo(0)));
    const fortnight = await getUsage(allowed, projectA, { days: "14" });
    expect(fortnight.ai.some((cell) => cell.day === label(daysAgo(10)))).toBe(true);
    expect(fortnight.mail.some((row) => row.day === label(daysAgo(10)))).toBe(true);
  });
  it("takes two weeks when no number is given, and refuses numbers outside 1 to 90", async () => {
    expect((await getUsage(allowed, projectA, {})).days).toBe(14);
    expect((await getUsage(allowed, projectA, { days: "1" })).days).toBe(1);
    expect((await getUsage(allowed, projectA, { days: "90" })).days).toBe(90);
    for (const days of ["0", "91", "-3", "x", "1.5"])
      await expect(getUsage(allowed, projectA, { days })).rejects.toThrow();
  });
});
describe("the mail", () => {
  it("counts what customers sent and what was sent to them, without notes, drafts and queued mail", async () => {
    const usage = await getUsage(allowed, projectA, { days: "14" });
    const today = usage.mail.find((row) => row.day === label(daysAgo(0)));
    expect(today).toEqual({ day: label(daysAgo(0)), received: 2, sent: 1 });
    const yesterday = usage.mail.find((row) => row.day === label(daysAgo(1)));
    expect(yesterday).toEqual({ day: label(daysAgo(1)), received: 0, sent: 1 });
  });
});
describe("the storage", () => {
  it("counts the stored files and their bytes, not the refused ones, and the raw mails", async () => {
    const usage = await getUsage(allowed, projectA, { days: "14" });
    expect(usage.storage).toEqual({ files: 2, bytes: 1234, rawMails: 1 });
  });
});
describe("the separation of projects and the rights", () => {
  it("shows nothing of another project", async () => {
    const own = await getUsage(reader(projectB, ["config.read"]), projectB, { days: "14" });
    expect(own.ai).toHaveLength(1);
    expect(own.ai[0]).toMatchObject({ calls: 1, inputTokens: 5000, charged: 777, budget: null });
    expect(own.storage).toEqual({ files: 1, bytes: 70_000, rawMails: 1 });
    expect(own.mail).toEqual([
      { day: label(daysAgo(0)), received: 1, sent: 0 },
      { day: label(daysAgo(2)), received: 1, sent: 0 },
    ]);
  });
  it("is answered as not found without the right to read the configuration, or for a project of another", async () => {
    expect(await outcome(getUsage(reader(projectA, ["project.read"]), projectA, {}))).toBe(
      "not_found",
    );
    expect(await outcome(getUsage(reader(projectB, ["config.read"]), projectA, {}))).toBe(
      "not_found",
    );
    expect(await outcome(getUsage({ ...allowed, active: false }, projectA, {}))).toBe("not_found");
    expect(await outcome(getUsage(allowed, projectA, {}))).toBe("ok");
  });
});
