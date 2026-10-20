import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  ingress,
  jobs,
  messages,
  projects,
  senderRules,
  tickets,
} from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import { restoreJunkMail } from "../src/server/operations";
import { initializeStorage } from "../src/server/storage";
import { addSenderRule, listSenderRules, removeSenderRule } from "../src/server/sender-rules";
import { classifyJunk, junkSensitivityOf } from "../src/domain/junk";
import { matchSender, maxSenderRules, normalizePattern } from "../src/domain/sender-rules";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const manager: Principal = {
  id: `manager-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: ["project.read", "intake.manage", "ticket.junk", "ticket.read"] }],
};
const reader: Principal = {
  ...manager,
  id: `reader-${projectId}`,
  grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
};
const outsider: Principal = {
  ...manager,
  id: `outsider-${projectId}`,
  grants: [{ projectId: otherProject, actions: ["intake.manage"] }],
};
const agent: Principal = { ...manager, kind: "agent" };
function mail(from: string, headers: string[] = []) {
  return Buffer.from(
    [
      `From: ${from}`,
      "To: support@example.test",
      `Subject: Hello ${randomUUID()}`,
      `Message-ID: <${randomUUID()}@example.test>`,
      ...headers,
      "MIME-Version: 1.0",
      "Content-Type: text/plain",
      "",
      "Hello",
      "",
    ].join("\r\n"),
  );
}
async function ingest(raw: Buffer, project = projectId) {
  const { ingressId } = await acceptInbound({
    projectId: project,
    connectionId: null,
    externalKey: `test:${randomUUID()}`,
    raw,
  });
  const outcome = await processIngress(ingressId);
  const [entry] = await db().select().from(ingress).where(eq(ingress.id, ingressId));
  return { ingressId, outcome, entry };
}
const setSensitivity = (value: string | null) =>
  db()
    .update(projects)
    .set({ settings: value === null ? {} : { junkSensitivity: value } })
    .where(eq(projects.id, projectId));
const clearRules = () => db().delete(senderRules).where(eq(senderRules.projectId, projectId));
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Senders", slug: `senders-${projectId}` },
      { id: otherProject, name: "Other", slug: `senders-${otherProject}` },
    ]);
});
afterAll(async () => {
  const ids = [projectId, otherProject];
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(ingress).where(inArray(ingress.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("sender rule patterns", () => {
  it("reads an address, a domain and a domain with a leading @", () => {
    expect(normalizePattern(" Kim@Example.ORG ")).toEqual({
      type: "address",
      value: "kim@example.org",
    });
    expect(normalizePattern("Example.org")).toEqual({ type: "domain", value: "example.org" });
    expect(normalizePattern("@example.org")).toEqual({ type: "domain", value: "example.org" });
    expect(normalizePattern("*@mail.example.org")).toEqual({
      type: "domain",
      value: "mail.example.org",
    });
    for (const bad of ["", "example", "kim@", "kim@example", "a b@example.org", "-x.example.org"])
      expect(normalizePattern(bad)).toBeNull();
    expect(normalizePattern(`${"a".repeat(65)}@example.org`)).toBeNull();
  });
  it("matches an address before a domain and the longest domain first", () => {
    const rules = [
      { kind: "block" as const, type: "domain" as const, value: "example.org" },
      { kind: "allow" as const, type: "domain" as const, value: "mail.example.org" },
      { kind: "allow" as const, type: "address" as const, value: "kim@example.org" },
    ];
    expect(matchSender(rules, "KIM@example.org")?.kind).toBe("allow");
    expect(matchSender(rules, "lee@example.org")?.kind).toBe("block");
    expect(matchSender(rules, "lee@a.example.org")?.kind).toBe("block");
    expect(matchSender(rules, "lee@mail.example.org")?.value).toBe("mail.example.org");
    expect(matchSender(rules, "lee@x.mail.example.org")?.value).toBe("mail.example.org");
    // A name that only ends in the same letters is not a subdomain.
    expect(matchSender(rules, "lee@badexample.org")).toBeNull();
    expect(matchSender([], "lee@example.org")).toBeNull();
  });
});
describe("junk sensitivity", () => {
  const verdict = (entries: [string, unknown][], level?: Parameters<typeof classifyJunk>[1]) =>
    classifyJunk(new Map(entries), level);
  it("keeps the verdict of the spam filter as the standard", () => {
    expect(junkSensitivityOf(undefined)).toBe("standard");
    expect(junkSensitivityOf("loud")).toBe("standard");
    expect(junkSensitivityOf("strict")).toBe("strict");
    expect(verdict([["x-spam-flag", "YES"]])).toEqual({ junk: true, reason: "spam_flag" });
    expect(verdict([["x-spam-flag", "YES"]], "standard").junk).toBe(true);
    expect(verdict([["precedence", "bulk"]], "standard").junk).toBe(false);
  });
  it("trusts no header when it is off", () => {
    expect(verdict([["x-spam-flag", "YES"]], "off")).toEqual({ junk: false, reason: null });
  });
  it("also keeps out bulk mail when it is strict", () => {
    for (const entries of [
      [["precedence", "bulk"]],
      [["precedence", " List"]],
      [["precedence", "junk"]],
      [["list", { unsubscribe: { url: "https://example.test/u" } }]],
      [["list", { id: { id: "news" } }]],
      [["list-id", "<news.example.test>"]],
      [["list-unsubscribe", "<mailto:u@example.test>"]],
    ] as [string, unknown][][])
      expect(verdict(entries, "strict")).toEqual({ junk: true, reason: "bulk_mail" });
    expect(verdict([["precedence", "first-class"]], "strict").junk).toBe(false);
    expect(verdict([["list", "x"]], "strict").junk).toBe(false);
    expect(verdict([], "strict").junk).toBe(false);
    expect(verdict([["x-spam-flag", "YES"]], "strict")).toEqual({
      junk: true,
      reason: "spam_flag",
    });
  });
});
describe("managing the lists", () => {
  it("adds, lists and removes with an audit entry, and refuses without the right", async () => {
    await clearRules();
    const added = await addSenderRule(manager, projectId, {
      kind: "block",
      value: "Spam.Example.org",
      note: "  noise  ",
    });
    expect(added).toMatchObject({
      kind: "block",
      type: "domain",
      value: "spam.example.org",
      note: "noise",
      createdBy: manager.id,
    });
    await addSenderRule(manager, projectId, { kind: "allow", value: "kim@spam.example.org" });
    const listed = await listSenderRules(manager, projectId);
    expect(listed.map((rule) => [rule.kind, rule.value])).toEqual([
      ["allow", "kim@spam.example.org"],
      ["block", "spam.example.org"],
    ]);
    await expect(
      addSenderRule(manager, projectId, { kind: "allow", value: "SPAM.example.org" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      addSenderRule(manager, projectId, { kind: "block", value: "not a name" }),
    ).rejects.toThrow();
    await expect(
      addSenderRule(manager, projectId, { kind: "block", value: "a.example.org", extra: 1 }),
    ).rejects.toThrow();
    for (const who of [reader, outsider])
      for (const run of [
        () => listSenderRules(who, projectId),
        () => addSenderRule(who, projectId, { kind: "block", value: "x.example.org" }),
        () => removeSenderRule(who, projectId, added.id),
      ])
        await expect(run()).rejects.toMatchObject({ code: "not_found" });
    for (const run of [
      () => listSenderRules(agent, projectId),
      () => addSenderRule(agent, projectId, { kind: "block", value: "x.example.org" }),
      () => removeSenderRule(agent, projectId, added.id),
      () => listSenderRules({ ...manager, active: false }, projectId),
    ])
      await expect(run()).rejects.toMatchObject({ code: "forbidden" });
    await expect(listSenderRules(manager, "not-an-id")).rejects.toThrow();
    // A rule of another project cannot be removed through this one.
    await expect(removeSenderRule(manager, projectId, randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await removeSenderRule(manager, projectId, added.id)).toEqual({ removed: true });
    expect(await listSenderRules(manager, projectId)).toHaveLength(1);
    const entries = await db().select().from(audit).where(eq(audit.projectId, projectId));
    expect(
      entries
        .filter((entry) => entry.action.startsWith("sender_rule."))
        .map((entry) => [entry.action, entry.detail]),
    ).toEqual(
      expect.arrayContaining([
        ["sender_rule.add", { kind: "block", type: "domain", value: "spam.example.org" }],
        ["sender_rule.add", { kind: "allow", type: "address", value: "kim@spam.example.org" }],
        ["sender_rule.remove", { kind: "block", type: "domain", value: "spam.example.org" }],
      ]),
    );
  });
  it("takes no more than the limit", async () => {
    await clearRules();
    await db()
      .insert(senderRules)
      .values(
        Array.from({ length: maxSenderRules }, (_, index) => ({
          projectId,
          kind: "block",
          type: "domain",
          value: `d${String(index)}.example.org`,
          createdBy: manager.id,
        })),
      );
    await expect(
      addSenderRule(manager, projectId, { kind: "block", value: "one-more.example.org" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await clearRules();
    await addSenderRule(manager, projectId, { kind: "block", value: "one-more.example.org" });
    await clearRules();
  });
});
describe("lists at intake", () => {
  it("keeps a blocked sender out, and an allowed one in despite the spam flag", async () => {
    await clearRules();
    await setSensitivity(null);
    await addSenderRule(manager, projectId, { kind: "block", value: "blocked.example.test" });
    await addSenderRule(manager, projectId, {
      kind: "allow",
      value: "friend@blocked.example.test",
    });
    await addSenderRule(manager, projectId, { kind: "allow", value: "trusted.example.test" });
    const blocked = await ingest(mail("Lee <lee@blocked.example.test>"));
    expect(blocked.outcome).toBe("junk");
    expect(blocked.entry).toMatchObject({ state: "junk", ticketId: null });
    expect(blocked.entry?.classification).toMatchObject({
      verdict: "junk",
      reason: "blocked_sender",
      source: "rules",
    });
    // A subdomain is covered by the rule of its domain.
    expect((await ingest(mail("x@sub.blocked.example.test"))).outcome).toBe("junk");
    // The address wins over the domain of another rule.
    const friend = await ingest(mail("Fay <friend@blocked.example.test>"));
    expect(friend.outcome).toBe("created");
    expect(friend.entry?.ticketId).toBeTruthy();
    // An allowed domain is not junk even when the headers say so.
    const flagged = await ingest(mail("Bo <bo@trusted.example.test>", ["X-Spam-Flag: YES"]));
    expect(flagged.outcome).toBe("created");
    // Without a rule the same headers keep the mail out.
    expect(
      (await ingest(mail("Al <al@elsewhere.example.test>", ["X-Spam-Flag: YES"]))).outcome,
    ).toBe("junk");
    // The lists of one project do not reach another.
    expect((await ingest(mail("Lee <lee@blocked.example.test>"), otherProject)).outcome).toBe(
      "created",
    );
  });
  it("lets a person restore a blocked mail once, and does not classify it again", async () => {
    await clearRules();
    await addSenderRule(manager, projectId, { kind: "block", value: "again.example.test" });
    const first = await ingest(mail("Lee <lee@again.example.test>"));
    expect(first.outcome).toBe("junk");
    expect(await restoreJunkMail(manager, first.ingressId)).toEqual({ restored: true });
    expect(await processIngress(first.ingressId)).toBe("created");
    const [after] = await db().select().from(ingress).where(eq(ingress.id, first.ingressId));
    expect(after?.ticketId).toBeTruthy();
    // A new mail of the same sender is blocked again.
    expect((await ingest(mail("Lee <lee@again.example.test>"))).outcome).toBe("junk");
  });
  it("keeps a blocked sender out of an existing ticket too", async () => {
    await clearRules();
    const open = await ingest(mail("Pat <pat@thread.example.test>"));
    const [first] = await db()
      .select()
      .from(messages)
      .where(eq(messages.ticketId, open.entry?.ticketId ?? ""));
    await addSenderRule(manager, projectId, { kind: "block", value: "thread.example.test" });
    const raw = Buffer.from(
      mail("Pat <pat@thread.example.test>", [`In-Reply-To: ${first?.receivedMessageId ?? ""}`]),
    );
    const reply = await ingest(raw);
    expect(reply.outcome).toBe("junk");
    expect(
      await db()
        .select()
        .from(messages)
        .where(eq(messages.ticketId, open.entry?.ticketId ?? "")),
    ).toHaveLength(1);
  });
  it("follows the sensitivity of the project for the headers", async () => {
    await clearRules();
    const newsletter = ["List-Unsubscribe: <mailto:stop@example.test>", "Precedence: bulk"];
    await setSensitivity("standard");
    expect((await ingest(mail("N <news@list.example.test>", newsletter))).outcome).toBe("created");
    await setSensitivity("strict");
    const strict = await ingest(mail("N <news@list.example.test>", newsletter));
    expect(strict.outcome).toBe("junk");
    expect(strict.entry?.classification).toMatchObject({ reason: "bulk_mail", source: "rules" });
    // An allowed sender passes even when strict.
    await addSenderRule(manager, projectId, { kind: "allow", value: "list.example.test" });
    expect((await ingest(mail("N <news@list.example.test>", newsletter))).outcome).toBe("created");
    await clearRules();
    await setSensitivity("off");
    expect((await ingest(mail("S <s@spam.example.test>", ["X-Spam-Flag: YES"]))).outcome).toBe(
      "created",
    );
    // Off does not switch off the blocked senders.
    await addSenderRule(manager, projectId, { kind: "block", value: "spam.example.test" });
    expect((await ingest(mail("S <s@spam.example.test>"))).outcome).toBe("junk");
    await setSensitivity(null);
    await clearRules();
  });
});
