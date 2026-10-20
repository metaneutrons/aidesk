import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  agentRuns,
  agents,
  audit,
  ingress,
  jobs,
  memberships,
  messages,
  operatorGroupMembers,
  operatorGroups,
  projects,
  routingRules,
  tickets,
  user,
  webhooks,
} from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import {
  createRoutingRule,
  deleteRoutingRule,
  listRoutingRules,
  listRoutingTargets,
  reorderRoutingRules,
  updateRoutingRule,
} from "../src/server/routing";
import { restoreJunkMail } from "../src/server/operations";
import { initializeStorage } from "../src/server/storage";
import { firstMatch, matches, nextMember, routingRuleInput } from "../src/domain/routing";
import type { Action, Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectId = randomUUID();
const otherProject = randomUUID();
const ids = {
  boss: `rt-boss-${run}`,
  kim: `rt-kim-${run}`,
  lee: `rt-lee-${run}`,
  mo: `rt-mo-${run}`,
  off: `rt-off-${run}`,
  stranger: `rt-stranger-${run}`,
};
const person = (id: string, held: Action[]): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: held }],
});
const boss = person(ids.boss, ["project.read", "ticket.read", "intake.manage"]);
const junkManager = person(`rt-junk-${run}`, ["project.read", "ticket.read", "ticket.junk"]);
const reader = person(`rt-reader-${run}`, ["project.read", "ticket.read"]);
const outsider: Principal = {
  ...boss,
  id: `rt-outsider-${run}`,
  grants: [{ projectId: otherProject, actions: ["intake.manage"] }],
};
const agent: Principal = { ...boss, kind: "agent" };
let group = "";
let emptyGroup = "";
let external = "";
let managed = "";
function mail(from: string, subject: string, headers: string[] = []) {
  return Buffer.from(
    [
      `From: ${from}`,
      "To: support@example.test",
      `Subject: ${subject}`,
      `Message-ID: <${randomUUID()}@example.test>`,
      ...headers,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello",
      "",
    ].join("\r\n"),
  );
}
async function arrive(from: string, subject: string, headers: string[] = []) {
  const { ingressId } = await acceptInbound({
    projectId,
    connectionId: null,
    externalKey: `test:${randomUUID()}`,
    raw: mail(from, subject, headers),
  });
  const outcome = await processIngress(ingressId);
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  const [made] = entry?.ticketId
    ? await db().select().from(tickets).where(eq(tickets.id, entry.ticketId))
    : [];
  return { outcome, ingressId, ticket: made };
}
const auditOf = async (ticketId: string, action: string) =>
  (await db().select().from(audit).where(eq(audit.targetId, ticketId))).filter(
    (entry) => entry.action === action,
  );
const rule = (change: Record<string, unknown>) => ({
  name: "Rule",
  conditions: { subjectWords: ["invoice"] },
  priority: "high",
  ...change,
});
const clearRules = () => db().delete(routingRules).where(eq(routingRules.projectId, projectId));
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      {
        id: projectId,
        name: "Routing",
        slug: `routing-${run}`,
        settings: { categories: "Billing\nSupport" },
      },
      { id: otherProject, name: "Other", slug: `routing-other-${run}` },
    ]);
  await db()
    .insert(user)
    .values(
      Object.entries(ids).map(([name, id]) => ({
        id,
        name: `Person ${name}`,
        email: `${id}@example.test`,
        emailVerified: true,
        active: name !== "off",
      })),
    );
  await db()
    .insert(memberships)
    .values(
      [ids.boss, ids.kim, ids.lee, ids.mo, ids.off].map((userId) => ({
        userId,
        projectId,
        actions: ["project.read", "ticket.read"] as Action[],
      })),
    );
  await db()
    .insert(operatorGroups)
    .values([
      { projectId, name: "Desk", actions: [], createdBy: ids.boss },
      { projectId, name: "Nobody", actions: [], createdBy: ids.boss },
    ]);
  const groups = await db()
    .select()
    .from(operatorGroups)
    .where(eq(operatorGroups.projectId, projectId));
  group = groups.find((entry) => entry.name === "Desk")?.id ?? "";
  emptyGroup = groups.find((entry) => entry.name === "Nobody")?.id ?? "";
  // The group has three members: two can read tickets, one is not active, one has no access to the project.
  await db()
    .insert(operatorGroupMembers)
    .values(
      [ids.kim, ids.lee, ids.off, ids.stranger].map((userId) => ({
        groupId: group,
        userId,
        addedBy: ids.boss,
      })),
    );
  await db()
    .insert(operatorGroupMembers)
    .values([{ groupId: emptyGroup, userId: ids.off, addedBy: ids.boss }]);
  const hold = (managedAgent: boolean) =>
    db()
      .insert(agents)
      .values({
        name: managedAgent ? "Managed" : "External",
        projectId,
        actions: ["ticket.read", "ticket.reply", "ticket.note"],
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        managed: managedAgent,
      })
      .returning({ id: agents.id });
  external = (await hold(false))[0]?.id ?? "";
  managed = (await hold(true))[0]?.id ?? "";
  await db()
    .insert(webhooks)
    .values({
      projectId,
      name: "Routing",
      url: "https://example.test/hook",
      events: ["ticket.assigned", "ticket.triaged"],
      secretCiphertext: "not-a-secret",
    });
}, 60_000);
afterAll(async () => {
  const projectIds = [projectId, otherProject];
  await db()
    .delete(agentRuns)
    .where(inArray(agentRuns.agentId, [external, managed]));
  await db().delete(jobs).where(inArray(jobs.projectId, projectIds));
  await db().delete(ingress).where(inArray(ingress.projectId, projectIds));
  await db().delete(tickets).where(inArray(tickets.projectId, projectIds));
  await db().delete(audit).where(inArray(audit.projectId, projectIds));
  await db().delete(webhooks).where(inArray(webhooks.projectId, projectIds));
  await db().delete(projects).where(inArray(projects.id, projectIds));
  await db()
    .delete(user)
    .where(inArray(user.id, Object.values(ids)));
  await sqlClient().end();
});
describe("matching a rule", () => {
  const mailOf = {
    sender: "Kim@Mail.Example.org",
    language: "de",
    subject: "Question about my Invoice",
  };
  const conditions = (change: Partial<Parameters<typeof matches>[0]>) => ({
    senders: [],
    languages: [],
    subjectWords: [],
    ...change,
  });
  it("matches when every named condition holds, and everything when none is named", () => {
    expect(matches(conditions({}), mailOf)).toBe(true);
    expect(matches(conditions({ senders: ["kim@mail.example.org"] }), mailOf)).toBe(true);
    expect(matches(conditions({ senders: ["example.org"] }), mailOf)).toBe(true);
    expect(matches(conditions({ senders: ["mail.example.org"] }), mailOf)).toBe(true);
    expect(matches(conditions({ senders: ["xample.org"] }), mailOf)).toBe(false);
    expect(matches(conditions({ senders: ["lee@mail.example.org", "other.test"] }), mailOf)).toBe(
      false,
    );
    expect(matches(conditions({ languages: ["en", "de"] }), mailOf)).toBe(true);
    expect(matches(conditions({ languages: ["en"] }), mailOf)).toBe(false);
    expect(matches(conditions({ subjectWords: ["refund", "INVOICE"] }), mailOf)).toBe(true);
    expect(matches(conditions({ subjectWords: ["refund"] }), mailOf)).toBe(false);
    expect(
      matches(
        conditions({ senders: ["example.org"], languages: ["de"], subjectWords: ["invoice"] }),
        mailOf,
      ),
    ).toBe(true);
    expect(
      matches(
        conditions({ senders: ["example.org"], languages: ["en"], subjectWords: ["invoice"] }),
        mailOf,
      ),
    ).toBe(false);
  });
  it("takes the first enabled rule that matches", () => {
    const rules = [
      { name: "off", enabled: false, conditions: conditions({}) },
      { name: "no", enabled: true, conditions: conditions({ languages: ["en"] }) },
      { name: "yes", enabled: true, conditions: conditions({ languages: ["de"] }) },
      { name: "default", enabled: true, conditions: conditions({}) },
    ];
    expect(firstMatch(rules, mailOf)?.name).toBe("yes");
    expect(firstMatch(rules.slice(0, 2), mailOf)).toBeNull();
    expect(firstMatch([], mailOf)).toBeNull();
  });
  it("takes the members of a group in turn, in a fixed order", () => {
    expect(nextMember([], 0)).toBeNull();
    expect(nextMember(["b", "a", "c"], 0)).toBe("a");
    expect(nextMember(["b", "a", "c"], 1)).toBe("b");
    expect(nextMember(["b", "a", "c"], 3)).toBe("a");
    expect(nextMember(["a"], 7)).toBe("a");
    expect(nextMember(["a", "b"], -1)).toBe("b");
  });
  it("reads a rule: conditions in their form, and something to do", () => {
    const ok = (value: unknown) => routingRuleInput.safeParse(value).success;
    expect(ok({ name: "x", priority: "low" })).toBe(true);
    expect(ok({ name: "x", target: { kind: "group", id: "g" } })).toBe(true);
    expect(ok({ name: "x", category: "Billing" })).toBe(true);
    expect(ok({ name: "x" })).toBe(false);
    expect(ok({ name: "", priority: "low" })).toBe(false);
    expect(ok({ name: "x", priority: "huge" })).toBe(false);
    expect(ok({ name: "x", priority: "low", conditions: { senders: ["not a name"] } })).toBe(false);
    expect(ok({ name: "x", priority: "low", conditions: { languages: ["Deutsch"] } })).toBe(false);
    expect(ok({ name: "x", priority: "low", conditions: { subjectWords: [""] } })).toBe(false);
    expect(ok({ name: "x", priority: "low", conditions: { other: 1 } })).toBe(false);
    expect(
      routingRuleInput.parse({
        name: "x",
        priority: "low",
        conditions: { senders: ["@Example.ORG"] },
      }).conditions.senders,
    ).toEqual(["example.org"]);
  });
});
describe("managing the rules", () => {
  it("adds, lists, changes, orders and removes with audit entries, in a stable order", async () => {
    await clearRules();
    const first = await createRoutingRule(boss, projectId, rule({ name: "First" }));
    const second = await createRoutingRule(boss, projectId, {
      name: "Second",
      target: { kind: "group", id: group },
      category: "billing",
    });
    expect(first.position).toBe(1);
    expect(second).toMatchObject({
      position: 2,
      category: "Billing",
      target: { kind: "group", id: group, name: "Desk" },
    });
    expect((await listRoutingRules(boss, projectId)).map((entry) => entry.name)).toEqual([
      "First",
      "Second",
    ]);
    const changed = await updateRoutingRule(
      boss,
      projectId,
      first.id,
      rule({ name: "First renamed", enabled: false }),
    );
    expect(changed).toMatchObject({ name: "First renamed", enabled: false, position: 1 });
    const reordered = await reorderRoutingRules(boss, projectId, { ids: [second.id, first.id] });
    expect(reordered.map((entry) => [entry.name, entry.position])).toEqual([
      ["Second", 1],
      ["First renamed", 2],
    ]);
    expect(await deleteRoutingRule(boss, projectId, second.id)).toEqual({ removed: true });
    const rest = await listRoutingRules(boss, projectId);
    expect(rest.map((entry) => [entry.name, entry.position])).toEqual([["First renamed", 1]]);
    const actions = (await db().select().from(audit).where(eq(audit.projectId, projectId)))
      .map((entry) => entry.action)
      .filter((action) => action.startsWith("routing_rule."));
    expect(actions).toEqual(
      expect.arrayContaining([
        "routing_rule.create",
        "routing_rule.update",
        "routing_rule.reorder",
        "routing_rule.delete",
      ]),
    );
    await clearRules();
  });
  it("refuses a target or a category that does not exist, and an order that is not the whole list", async () => {
    await clearRules();
    const invalid = (input: Record<string, unknown>) =>
      expect(createRoutingRule(boss, projectId, input)).rejects.toMatchObject({
        code: "invalid_input",
      });
    await invalid(rule({ category: "Gossip" }));
    await invalid(rule({ target: { kind: "user", id: ids.off } }));
    await invalid(rule({ target: { kind: "user", id: ids.stranger } }));
    await invalid(rule({ target: { kind: "user", id: "nobody-at-all" } }));
    await invalid(rule({ target: { kind: "group", id: randomUUID() } }));
    await invalid(rule({ target: { kind: "group", id: "not-an-id" } }));
    await invalid(rule({ target: { kind: "agent", id: randomUUID() } }));
    await invalid(rule({ target: { kind: "agent", id: "not-an-id" } }));
    await db().update(agents).set({ active: false }).where(eq(agents.id, external));
    await invalid(rule({ target: { kind: "agent", id: external } }));
    await db().update(agents).set({ active: true }).where(eq(agents.id, external));
    for (const target of [
      { kind: "user", id: ids.kim },
      { kind: "group", id: group },
      { kind: "agent", id: external },
    ])
      await createRoutingRule(boss, projectId, rule({ target }));
    const listed = await listRoutingRules(boss, projectId);
    expect(listed.map((entry) => entry.target?.name)).toEqual(["Person kim", "Desk", "External"]);
    const order = listed.map((entry) => entry.id);
    for (const bad of [order.slice(1), [...order, randomUUID()], [order[0], order[0], order[1]]])
      await expect(reorderRoutingRules(boss, projectId, { ids: bad })).rejects.toThrow();
    await expect(updateRoutingRule(boss, projectId, randomUUID(), rule({}))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(deleteRoutingRule(boss, projectId, randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
    await clearRules();
  });
  it("takes at most fifty rules, and refuses without the right", async () => {
    await clearRules();
    await db()
      .insert(routingRules)
      .values(
        Array.from({ length: 50 }, (_, index) => ({
          projectId,
          position: index + 1,
          name: `r${String(index)}`,
          conditions: { senders: [], languages: [], subjectWords: [] },
          priority: "low",
          createdBy: ids.boss,
        })),
      );
    await expect(createRoutingRule(boss, projectId, rule({}))).rejects.toMatchObject({
      code: "invalid_input",
    });
    await clearRules();
    const made = await createRoutingRule(boss, projectId, rule({}));
    for (const who of [reader, outsider])
      for (const call of [
        () => listRoutingRules(who, projectId),
        () => listRoutingTargets(who, projectId),
        () => createRoutingRule(who, projectId, rule({})),
        () => updateRoutingRule(who, projectId, made.id, rule({})),
        () => deleteRoutingRule(who, projectId, made.id),
        () => reorderRoutingRules(who, projectId, { ids: [made.id] }),
      ])
        await expect(call()).rejects.toMatchObject({ code: "not_found" });
    for (const call of [
      () => listRoutingRules(agent, projectId),
      () => createRoutingRule(agent, projectId, rule({})),
      () => deleteRoutingRule({ ...boss, active: false }, projectId, made.id),
    ])
      await expect(call()).rejects.toMatchObject({ code: "forbidden" });
    await clearRules();
  });
  it("lists whom a rule can name", async () => {
    const targets = await listRoutingTargets(boss, projectId);
    expect(targets.users.map((entry) => entry.id).sort()).toEqual(
      [ids.boss, ids.kim, ids.lee, ids.mo].sort(),
    );
    expect(targets.groups.map((entry) => entry.name)).toEqual(["Desk", "Nobody"]);
    expect(targets.agents.map((entry) => entry.name)).toEqual(["External", "Managed"]);
  });
});
describe("routing a new ticket", () => {
  it("hands it to the person, sets priority and category, and announces both", async () => {
    await clearRules();
    await createRoutingRule(
      boss,
      projectId,
      rule({ target: { kind: "user", id: ids.mo }, priority: "urgent", category: "BILLING" }),
    );
    const { outcome, ticket } = await arrive("Pat <pat@example.test>", "Invoice 17 is wrong");
    expect(outcome).toBe("created");
    expect(ticket).toMatchObject({
      assigneeUserId: ids.mo,
      assigneeAgentId: null,
      priority: "urgent",
      category: "Billing",
    });
    const entry = (await auditOf(ticket?.id ?? "", "ticket.route"))[0];
    expect(entry).toMatchObject({
      actorId: "system",
      detail: { assigneeUserId: ids.mo, priority: "urgent", category: "Billing" },
    });
    const events = (
      await db()
        .select()
        .from(jobs)
        .where(and(eq(jobs.projectId, projectId), eq(jobs.type, "webhook.deliver")))
    )
      .map((job) => job.payload.event as { type: string; data: Record<string, unknown> })
      .filter((event) => event.data.ticketId === ticket?.id)
      .map((event) => event.type);
    expect(events).toEqual(expect.arrayContaining(["ticket.assigned", "ticket.triaged"]));
  });
  it("tries the rules in order and leaves a ticket alone that no rule matches", async () => {
    await clearRules();
    await createRoutingRule(
      boss,
      projectId,
      rule({ name: "Invoices", target: { kind: "user", id: ids.kim } }),
    );
    await createRoutingRule(
      boss,
      projectId,
      rule({
        name: "German",
        conditions: { languages: ["de"] },
        target: { kind: "user", id: ids.lee },
        priority: "low",
      }),
    );
    await createRoutingRule(boss, projectId, {
      name: "Default",
      target: { kind: "user", id: ids.mo },
    });
    const invoice = (await arrive("a@example.test", "My invoice")).ticket;
    expect(invoice).toMatchObject({ assigneeUserId: ids.kim, priority: "high" });
    const other = (await arrive("b@example.test", "Printer")).ticket;
    expect(other).toMatchObject({ assigneeUserId: ids.mo, priority: "normal" });
    // The default is an ordinary rule: take it away and the ticket stays with nobody.
    const rules = await listRoutingRules(boss, projectId);
    await deleteRoutingRule(boss, projectId, rules.at(-1)?.id ?? "");
    const nobody = (await arrive("c@example.test", "Printer again")).ticket;
    expect(nobody).toMatchObject({
      assigneeUserId: null,
      assigneeAgentId: null,
      priority: "normal",
    });
    expect(await auditOf(nobody?.id ?? "", "ticket.route")).toHaveLength(0);
    expect(await auditOf(nobody?.id ?? "", "ticket.route_failed")).toHaveLength(0);
  });
  it("skips a rule that is switched off, and takes the sender and the language into account", async () => {
    await clearRules();
    const off = await createRoutingRule(
      boss,
      projectId,
      rule({ name: "Off", conditions: {}, target: { kind: "user", id: ids.kim } }),
    );
    await updateRoutingRule(
      boss,
      projectId,
      off.id,
      rule({ name: "Off", enabled: false, conditions: {}, target: { kind: "user", id: ids.kim } }),
    );
    await createRoutingRule(
      boss,
      projectId,
      rule({
        name: "VIP",
        conditions: { senders: ["vip.example.test"] },
        target: { kind: "user", id: ids.lee },
      }),
    );
    expect((await arrive("x@example.test", "Hello")).ticket?.assigneeUserId).toBeNull();
    expect(
      (await arrive("Boss <boss@mail.vip.example.test>", "Hello")).ticket?.assigneeUserId,
    ).toBe(ids.lee);
    expect((await arrive("boss@notvip.example.test", "Hello")).ticket?.assigneeUserId).toBeNull();
  });
  it("takes the members of a group in turn, and skips who cannot take a ticket", async () => {
    await clearRules();
    await createRoutingRule(boss, projectId, {
      name: "Desk",
      conditions: {},
      target: { kind: "group", id: group },
    });
    // Kim and Lee can take tickets; the inactive member and the one without access are left out.
    const given: (string | null | undefined)[] = [];
    for (let index = 0; index < 5; index += 1)
      given.push((await arrive(`p${String(index)}@example.test`, "Round")).ticket?.assigneeUserId);
    const order = [ids.kim, ids.lee].sort();
    expect(given).toEqual([order[0], order[1], order[0], order[1], order[0]]);
    const [stored] = await db()
      .select()
      .from(routingRules)
      .where(eq(routingRules.projectId, projectId));
    expect(stored?.cursor).toBe(5);
  });
  it("leaves the ticket unassigned and says why when nobody can take it, and still applies the rest", async () => {
    await clearRules();
    await createRoutingRule(boss, projectId, {
      name: "Nobody",
      conditions: {},
      target: { kind: "group", id: emptyGroup },
      priority: "high",
    });
    const { ticket } = await arrive("q@example.test", "Anybody there");
    expect(ticket).toMatchObject({ assigneeUserId: null, assigneeAgentId: null, priority: "high" });
    const failed = await auditOf(ticket?.id ?? "", "ticket.route_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toMatchObject({
      reason: "nobody_in_group",
      rule: { name: "Nobody" },
    });
    expect(await auditOf(ticket?.id ?? "", "ticket.route")).toHaveLength(0);
    // The same when the person or the agent has gone since the rule was made.
    await clearRules();
    const made = await createRoutingRule(
      boss,
      projectId,
      rule({ conditions: {}, target: { kind: "user", id: ids.kim } }),
    );
    await db().update(user).set({ active: false }).where(eq(user.id, ids.kim));
    const gone = (await arrive("r@example.test", "Kim is away")).ticket;
    await db().update(user).set({ active: true }).where(eq(user.id, ids.kim));
    expect(gone?.assigneeUserId).toBeNull();
    expect((await auditOf(gone?.id ?? "", "ticket.route_failed"))[0]?.detail).toMatchObject({
      reason: "person_unavailable",
    });
    await deleteRoutingRule(boss, projectId, made.id);
    await createRoutingRule(
      boss,
      projectId,
      rule({ conditions: {}, target: { kind: "agent", id: external } }),
    );
    await db().update(agents).set({ active: false }).where(eq(agents.id, external));
    const noAgent = (await arrive("s@example.test", "Agent is away")).ticket;
    await db().update(agents).set({ active: true }).where(eq(agents.id, external));
    expect(noAgent?.assigneeAgentId).toBeNull();
    expect((await auditOf(noAgent?.id ?? "", "ticket.route_failed"))[0]?.detail).toMatchObject({
      reason: "agent_unavailable",
    });
  });
  it("gives the ticket to an agent, and starts a managed agent on it", async () => {
    await clearRules();
    await createRoutingRule(boss, projectId, {
      name: "Managed",
      conditions: { subjectWords: ["robot"] },
      target: { kind: "agent", id: managed },
    });
    await createRoutingRule(boss, projectId, {
      name: "External",
      conditions: { subjectWords: ["plain"] },
      target: { kind: "agent", id: external },
    });
    const robot = (await arrive("t@example.test", "Robot please")).ticket;
    expect(robot).toMatchObject({ assigneeAgentId: managed, assigneeUserId: null });
    expect(
      await db()
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.ticketId, robot?.id ?? "")),
    ).toHaveLength(1);
    const plain = (await arrive("u@example.test", "Plain agent")).ticket;
    expect(plain?.assigneeAgentId).toBe(external);
    expect(
      await db()
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.ticketId, plain?.id ?? "")),
    ).toHaveLength(0);
  });
  it("does not route a reply to a ticket, a mail kept out as junk, or a ticket twice", async () => {
    await clearRules();
    await createRoutingRule(boss, projectId, {
      name: "All",
      conditions: {},
      target: { kind: "user", id: ids.kim },
    });
    const first = await arrive("v@example.test", "Thread");
    expect(first.ticket?.assigneeUserId).toBe(ids.kim);
    await db()
      .update(tickets)
      .set({ assigneeUserId: ids.mo })
      .where(eq(tickets.id, first.ticket?.id ?? ""));
    // A reply that threads into the ticket is not routed again.
    const [firstMessage] = await db()
      .select({ id: messages.receivedMessageId })
      .from(messages)
      .where(eq(messages.ticketId, first.ticket?.id ?? ""));
    const reply = await arrive("v@example.test", "Re: Thread", [
      `In-Reply-To: ${firstMessage?.id ?? ""}`,
      `References: ${firstMessage?.id ?? ""}`,
    ]);
    expect(reply.outcome).toBe("appended");
    expect(reply.ticket?.id).toBe(first.ticket?.id);
    expect(reply.ticket?.assigneeUserId).toBe(ids.mo);
    // A mail that the rules keep out as junk creates no ticket and so routes nothing.
    const junk = await arrive("w@example.test", "Offer", ["X-Spam-Flag: YES"]);
    expect(junk.outcome).toBe("junk");
    expect(junk.ticket).toBeUndefined();
    // Restored, it is a new ticket that is routed like any other.
    await restoreJunkMail(junkManager, junk.ingressId);
    expect(await processIngress(junk.ingressId)).toBe("created");
    const [restored] = await db().select().from(ingress).where(eq(ingress.id, junk.ingressId));
    const [made] = await db()
      .select()
      .from(tickets)
      .where(eq(tickets.id, restored?.ticketId ?? ""));
    expect(made?.assigneeUserId).toBe(ids.kim);
    expect(await auditOf(first.ticket?.id ?? "", "ticket.route")).toHaveLength(1);
  });
  it("does not let a failure of the routing fail the intake of the mail", async () => {
    await clearRules();
    // A rule whose group is gone at the time of routing is an error case that is audited, not thrown.
    await db()
      .insert(routingRules)
      .values({
        projectId,
        position: 1,
        name: "Broken",
        conditions: { senders: [], languages: [], subjectWords: [] },
        target: { kind: "group", id: "not-a-uuid" },
        createdBy: ids.boss,
      });
    const { outcome, ticket } = await arrive("x2@example.test", "Still arrives");
    expect(outcome).toBe("created");
    expect(ticket?.assigneeUserId).toBeNull();
    expect((await auditOf(ticket?.id ?? "", "ticket.route_failed"))[0]?.detail).toMatchObject({
      reason: "error",
      rule: { name: "Broken" },
    });
    await clearRules();
  });
  it("stays within its own project", async () => {
    await clearRules();
    await createRoutingRule(boss, projectId, {
      name: "All",
      conditions: {},
      target: { kind: "user", id: ids.kim },
    });
    const [theirs] = await db()
      .select({ count: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.projectId, otherProject)));
    expect(theirs).toBeUndefined();
  });
});
