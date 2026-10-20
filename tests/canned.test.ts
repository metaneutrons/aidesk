import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  agents,
  audit,
  cannedReplies,
  configChanges,
  memberships,
  projects,
  tickets,
  user,
} from "../src/server/db/schema";
import {
  cannedForTicket,
  createCannedReply,
  deleteCannedReply,
  listCannedReplies,
  updateCannedReply,
} from "../src/server/canned";
import { decideConfigChange } from "../src/server/configuration";
import {
  cannedInput,
  cannedProblems,
  maxCannedReplies,
  placeholdersIn,
  renderCanned,
} from "../src/domain/canned";
import type { Action, Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectId = randomUUID();
const otherProject = randomUUID();
const ids = {
  writer: `cn-writer-${run}`,
  approver: `cn-approver-${run}`,
  replier: `cn-replier-${run}`,
};
const person = (id: string, held: Action[]): Principal => ({
  id,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: held }],
});
const writer = person(ids.writer, [
  "project.read",
  "ticket.read",
  "ticket.reply",
  "config.read",
  "config.write",
]);
const approver = person(ids.approver, ["project.read", "config.read", "config.approve"]);
const replier = person(ids.replier, ["project.read", "ticket.read", "ticket.reply"]);
const reader = person(`cn-reader-${run}`, ["project.read", "ticket.read", "config.read"]);
const outsider: Principal = {
  ...writer,
  id: `cn-outsider-${run}`,
  grants: [{ projectId: otherProject, actions: ["config.read", "config.write", "ticket.reply"] }],
};
let agentId = "";
let agent: Principal = writer;
const outcomeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof Error && "code" in error ? String(error.code) : "other"),
  );
const reply = (change: Record<string, unknown> = {}) => ({
  name: "Greeting",
  language: "en",
  body: "Hello {{customer_name}}, this is {{operator_name}} about ticket #{{ticket_number}}.",
  ...change,
});
const clear = async () => {
  await db().delete(cannedReplies).where(eq(cannedReplies.projectId, projectId));
  await db().delete(configChanges).where(eq(configChanges.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
};
async function ticket(language = "en") {
  const [row] = await db()
    .insert(tickets)
    .values({
      projectId,
      subject: "Canned",
      requesterEmail: "kim@example.test",
      requesterName: "Kim Meier",
      language,
    })
    .returning({ id: tickets.id, number: tickets.number });
  return { id: row?.id ?? "", number: row?.number ?? 0 };
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Canned", slug: `canned-${run}` },
      { id: otherProject, name: "Other", slug: `canned-other-${run}` },
    ]);
  await db()
    .insert(user)
    .values(
      Object.values(ids).map((id) => ({
        id,
        name: id === ids.writer ? "Wanda Writer" : id,
        email: `${id}@example.test`,
        emailVerified: true,
      })),
    );
  await db()
    .insert(memberships)
    .values(
      [writer, approver, replier].map((who) => ({
        userId: who.id,
        projectId,
        actions: [...(who.grants[0]?.actions ?? [])],
      })),
    );
  const [made] = await db()
    .insert(agents)
    .values({
      name: "Helper Bot",
      projectId,
      actions: ["ticket.read", "ticket.reply", "config.read", "config.write"],
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: agents.id });
  agentId = made?.id ?? "";
  agent = {
    id: agentId,
    kind: "agent",
    active: true,
    owner: false,
    grants: [
      {
        projectId,
        actions: ["project.read", "ticket.read", "ticket.reply", "config.read", "config.write"],
      },
    ],
  };
}, 60_000);
afterAll(async () => {
  await clear();
  await db()
    .delete(tickets)
    .where(inArray(tickets.projectId, [projectId, otherProject]));
  await db().delete(agents).where(eq(agents.id, agentId));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectId, otherProject]));
  await db()
    .delete(user)
    .where(inArray(user.id, Object.values(ids)));
  await sqlClient().end();
});
describe("placeholders", () => {
  it("lists the names between double braces once, in order of use", () => {
    expect(
      placeholdersIn("{{customer_name}} and {{ ticket_number }} and {{customer_name}}"),
    ).toEqual(["customer_name", "ticket_number"]);
    expect(placeholdersIn("no braces")).toEqual([]);
  });
  it("accepts the three placeholders and refuses others and open braces", () => {
    expect(cannedProblems("{{customer_name}} {{ticket_number}} {{operator_name}}")).toEqual([]);
    expect(cannedProblems("{{customer}}")).toEqual(["Unknown placeholder {{customer}}"]);
    expect(cannedProblems("Hello {{customer_name")).toEqual(["Braces that are not closed"]);
    expect(cannedProblems("Hello customer_name}}")).toEqual(["Braces that are not closed"]);
    expect(cannedProblems("{{ }}")).toEqual(["Unknown placeholder {{}}"]);
  });
  it("fills the values in, also with spaces inside the braces, and leaves unknown ones", () => {
    const values = { customer_name: "Kim", ticket_number: "17", operator_name: "Lee" };
    expect(
      renderCanned("Hi {{customer_name}} ({{ ticket_number }}) from {{operator_name}}", values),
    ).toBe("Hi Kim (17) from Lee");
    expect(renderCanned("{{customer_name}}{{customer_name}}", values)).toBe("KimKim");
    expect(renderCanned("{{unknown}}", values)).toBe("{{unknown}}");
    expect(renderCanned("[{{operator_name}}]", { ...values, operator_name: "" })).toBe("[]");
  });
  it("reads a reply: a name, a language and a body with valid placeholders", () => {
    const ok = (value: unknown) => cannedInput.safeParse(value).success;
    expect(ok(reply())).toBe(true);
    expect(ok(reply({ language: "fr" }))).toBe(false);
    expect(ok(reply({ name: "  " }))).toBe(false);
    expect(ok(reply({ body: "" }))).toBe(false);
    expect(ok(reply({ body: "{{nope}}" }))).toBe(false);
    expect(ok(reply({ body: "x".repeat(4001) }))).toBe(false);
    expect(ok(reply({ other: 1 }))).toBe(false);
    expect(ok(reply({ expectedVersion: 0 }))).toBe(false);
  });
});
describe("managing the replies", () => {
  it("adds, lists, changes and removes with versions and audit entries", async () => {
    await clear();
    const made = await createCannedReply(writer, projectId, reply());
    expect(made).toMatchObject({ outcome: "applied", version: 1 });
    const [listed] = await listCannedReplies(writer, projectId);
    expect(listed).toMatchObject({ name: "Greeting", language: "en", version: 1 });
    const id = listed?.id ?? "";
    expect(made.target).toBe(id);
    const changed = await updateCannedReply(
      writer,
      projectId,
      id,
      reply({ body: "Hello {{customer_name}}.", expectedVersion: 1 }),
    );
    expect(changed).toMatchObject({ outcome: "applied", version: 2 });
    expect(changed.diff.map((entry) => entry.pointer)).toEqual([`/canned/${id}/body`]);
    expect((await listCannedReplies(writer, projectId))[0]).toMatchObject({
      body: "Hello {{customer_name}}.",
      version: 2,
    });
    const unchanged = await updateCannedReply(
      writer,
      projectId,
      id,
      reply({ body: "Hello {{customer_name}}.", expectedVersion: 2 }),
    );
    expect(unchanged.outcome).toBe("unchanged");
    expect((await listCannedReplies(writer, projectId))[0]?.version).toBe(2);
    const renamed = await updateCannedReply(
      writer,
      projectId,
      id,
      reply({ name: "Welcome", language: "de", body: "Hallo.", expectedVersion: 2 }),
    );
    expect(renamed.diff.map((entry) => entry.pointer).sort()).toEqual(
      [`/canned/${id}/body`, `/canned/${id}/language`, `/canned/${id}/name`].sort(),
    );
    expect(await deleteCannedReply(writer, projectId, id, { expectedVersion: 3 })).toMatchObject({
      outcome: "applied",
    });
    expect(await listCannedReplies(writer, projectId)).toEqual([]);
    const actions = (await db().select().from(audit).where(eq(audit.projectId, projectId)))
      .map((entry) => entry.action)
      .filter((action) => action.startsWith("canned."));
    expect(actions.sort()).toEqual([
      "canned.create",
      "canned.delete",
      "canned.update",
      "canned.update",
    ]);
  });
  it("refuses a stale version, a clash of names (any case, one language) and too many replies", async () => {
    await clear();
    const made = await createCannedReply(writer, projectId, reply());
    const id = made.target ?? "";
    expect(
      await outcomeOf(
        updateCannedReply(writer, projectId, id, reply({ body: "x", expectedVersion: 5 })),
      ),
    ).toBe("stale_version");
    expect(await outcomeOf(deleteCannedReply(writer, projectId, id, { expectedVersion: 5 }))).toBe(
      "stale_version",
    );
    expect(await outcomeOf(createCannedReply(writer, projectId, reply({ name: "GREETING" })))).toBe(
      "conflict",
    );
    expect(
      await outcomeOf(
        createCannedReply(writer, projectId, reply({ name: "greeting", language: "de" })),
      ),
    ).toBe("ok");
    const other = await createCannedReply(writer, projectId, reply({ name: "Other" }));
    expect(
      await outcomeOf(
        updateCannedReply(
          writer,
          projectId,
          other.target ?? "",
          reply({ name: "greeting", expectedVersion: 1 }),
        ),
      ),
    ).toBe("conflict");
    expect(
      await outcomeOf(
        updateCannedReply(writer, projectId, randomUUID(), reply({ expectedVersion: 1 })),
      ),
    ).toBe("not_found");
    expect(
      await outcomeOf(deleteCannedReply(writer, projectId, randomUUID(), { expectedVersion: 1 })),
    ).toBe("not_found");
    await expect(updateCannedReply(writer, projectId, id, reply())).rejects.toThrow();
    await clear();
    await db()
      .insert(cannedReplies)
      .values(
        Array.from({ length: maxCannedReplies }, (_, index) => ({
          projectId,
          name: `r${String(index)}`,
          language: "en",
          body: "x",
          createdBy: ids.writer,
        })),
      );
    expect(await outcomeOf(createCannedReply(writer, projectId, reply({ name: "one more" })))).toBe(
      "invalid_input",
    );
    await clear();
  });
  it("checks the right: readers read, writers write, others see nothing", async () => {
    await clear();
    const made = await createCannedReply(writer, projectId, reply());
    const id = made.target ?? "";
    expect((await listCannedReplies(reader, projectId)).length).toBe(1);
    expect((await listCannedReplies(replier, projectId)).length).toBe(1);
    expect(await outcomeOf(createCannedReply(reader, projectId, reply({ name: "Two" })))).toBe(
      "forbidden",
    );
    expect(
      await outcomeOf(updateCannedReply(reader, projectId, id, reply({ expectedVersion: 1 }))),
    ).toBe("forbidden");
    expect(await outcomeOf(deleteCannedReply(reader, projectId, id, { expectedVersion: 1 }))).toBe(
      "forbidden",
    );
    for (const call of [
      () => listCannedReplies(outsider, projectId),
      () => createCannedReply(outsider, projectId, reply({ name: "Three" })),
      () => deleteCannedReply(outsider, projectId, id, { expectedVersion: 1 }),
    ])
      expect(await outcomeOf(call())).toBe("not_found");
    expect(await listCannedReplies(writer, projectId)).toHaveLength(1);
    await clear();
  });
  it("reports what would happen with validate and writes nothing", async () => {
    await clear();
    const checked = await createCannedReply(writer, projectId, reply(), { validate: true });
    expect(checked).toMatchObject({ outcome: "applied", validated: true });
    expect(await listCannedReplies(writer, projectId)).toEqual([]);
    expect(
      await db().select().from(configChanges).where(eq(configChanges.projectId, projectId)),
    ).toEqual([]);
  });
  it("is idempotent for a repeated request with the same key", async () => {
    await clear();
    const key = randomUUID();
    const first = await createCannedReply(writer, projectId, reply({ idempotencyKey: key }));
    const again = await createCannedReply(writer, projectId, reply({ idempotencyKey: key }));
    expect(again.changeId).toBe(first.changeId);
    expect(await listCannedReplies(writer, projectId)).toHaveLength(1);
  });
});
describe("an agent proposes", () => {
  it("adds, changes and removes nothing until a person with config.approve decides", async () => {
    await clear();
    const proposed = await createCannedReply(agent, projectId, reply({ name: "By agent" }));
    expect(proposed).toMatchObject({ outcome: "proposed", changeId: expect.any(String) });
    expect(await listCannedReplies(writer, projectId)).toEqual([]);
    expect(
      await decideConfigChange(approver, proposed.changeId ?? "", { decision: "approve" }),
    ).toBeDefined();
    const [made] = await listCannedReplies(writer, projectId);
    expect(made).toMatchObject({ name: "By agent", version: 1 });
    const id = made?.id ?? "";
    const change = await updateCannedReply(
      agent,
      projectId,
      id,
      reply({ name: "By agent", body: "New text", expectedVersion: 1 }),
    );
    expect(change.outcome).toBe("proposed");
    expect((await listCannedReplies(writer, projectId))[0]?.body).not.toBe("New text");
    await decideConfigChange(approver, change.changeId ?? "", { decision: "approve" });
    expect((await listCannedReplies(writer, projectId))[0]).toMatchObject({
      body: "New text",
      version: 2,
    });
    const removal = await deleteCannedReply(agent, projectId, id, { expectedVersion: 2 });
    expect(removal.outcome).toBe("proposed");
    expect(await listCannedReplies(writer, projectId)).toHaveLength(1);
    await decideConfigChange(approver, removal.changeId ?? "", { decision: "approve" });
    expect(await listCannedReplies(writer, projectId)).toEqual([]);
  });
  it("lets a proposal lapse when the reply changed in the meantime, and rejects on request", async () => {
    await clear();
    const made = await createCannedReply(writer, projectId, reply());
    const id = made.target ?? "";
    const stale = await updateCannedReply(
      agent,
      projectId,
      id,
      reply({ body: "Agent text", expectedVersion: 1 }),
    );
    await updateCannedReply(
      writer,
      projectId,
      id,
      reply({ body: "Person text", expectedVersion: 1 }),
    );
    expect(
      await outcomeOf(decideConfigChange(approver, stale.changeId ?? "", { decision: "approve" })),
    ).not.toBe("other");
    expect((await listCannedReplies(writer, projectId))[0]?.body).toBe("Person text");
    const rejected = await deleteCannedReply(agent, projectId, id, { expectedVersion: 2 });
    await decideConfigChange(approver, rejected.changeId ?? "", { decision: "reject" });
    expect(await listCannedReplies(writer, projectId)).toHaveLength(1);
    // A proposal to add a reply whose name was taken meanwhile does not apply.
    const late = await createCannedReply(agent, projectId, reply({ name: "Late" }));
    await createCannedReply(writer, projectId, reply({ name: "late" }));
    expect(
      await outcomeOf(decideConfigChange(approver, late.changeId ?? "", { decision: "approve" })),
    ).not.toBe("other");
    expect(
      (await listCannedReplies(writer, projectId)).filter(
        (entry) => entry.name.toLowerCase() === "late",
      ),
    ).toHaveLength(1);
  });
});
describe("a reply for a ticket", () => {
  it("fills in the customer, the number and the one who asks, the language of the ticket first", async () => {
    await clear();
    await createCannedReply(writer, projectId, reply({ name: "B English" }));
    await createCannedReply(
      writer,
      projectId,
      reply({
        name: "A Deutsch",
        language: "de",
        body: "Hallo {{customer_name}}, Ticket {{ticket_number}}.",
      }),
    );
    const german = await ticket("de");
    const english = await ticket("en");
    const forGerman = await cannedForTicket(replier, german.id);
    expect(forGerman.map((entry) => entry.name)).toEqual(["A Deutsch", "B English"]);
    expect(forGerman[0]?.text).toBe(`Hallo Kim Meier, Ticket ${String(german.number)}.`);
    expect(forGerman[1]?.text).toBe(
      `Hello Kim Meier, this is ${ids.replier} about ticket #${String(german.number)}.`,
    );
    expect((await cannedForTicket(writer, english.id)).map((entry) => entry.name)).toEqual([
      "B English",
      "A Deutsch",
    ]);
    expect((await cannedForTicket(writer, english.id))[0]?.text).toContain(
      "this is Wanda Writer about",
    );
    // An agent is named by its own name.
    expect((await cannedForTicket(agent, english.id))[0]?.text).toContain(
      "this is Helper Bot about",
    );
    // Other projects have their own replies.
    expect(await outcomeOf(cannedForTicket(reader, english.id))).toBe("forbidden");
    expect(await outcomeOf(cannedForTicket(outsider, english.id))).toBe("not_found");
    expect(await outcomeOf(cannedForTicket(replier, randomUUID()))).toBe("not_found");
    await clear();
    await db().delete(tickets).where(eq(tickets.projectId, projectId));
  });
  it("is empty for a project without replies", async () => {
    await clear();
    const one = await ticket();
    expect(await cannedForTicket(replier, one.id)).toEqual([]);
    await db().delete(tickets).where(eq(tickets.projectId, projectId));
  });
});
