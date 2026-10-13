import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ZodError } from "zod";
import { db, sqlClient } from "../src/server/db";
import { audit, configChanges, projects, projectTexts } from "../src/server/db/schema";
import { decideConfigChange, getConfig, putConfig } from "../src/server/configuration";
import { activeTexts, listTextVersions, listTexts, setText } from "../src/server/texts";
import { acknowledgementText } from "../src/domain/acknowledgement";
import { portalLinkText } from "../src/domain/email-design";
import { baseLanguage, fillText, textKeys, textProblems } from "../src/domain/texts";
import type { Action, Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const other = randomUUID();
const person = (
  name: string,
  kind: "human" | "agent",
  held: Action[],
  project = projectId,
): Principal => ({
  id: `${name}-${projectId}`,
  kind,
  active: true,
  owner: false,
  grants: [{ projectId: project, actions: held }],
});
const manager = person("manager", "human", [
  "project.read",
  "config.read",
  "config.write",
  "config.approve",
]);
const agent = person("agent", "agent", ["project.read", "config.read", "config.write"]);
const reader = person("reader", "human", ["project.read", "config.read"]);
const plain = person("plain", "human", ["project.read"]);
const elsewhere = person("elsewhere", "human", ["config.read", "config.write"], other);
const ack = "acknowledgement";
async function reset() {
  await db().delete(projectTexts).where(eq(projectTexts.projectId, projectId));
  await db().delete(configChanges).where(eq(configChanges.projectId, projectId));
  await db()
    .update(projects)
    .set({ settings: {}, configVersion: 1 })
    .where(eq(projects.id, projectId));
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Texts", slug: `texts-${projectId}` },
      { id: other, name: "Other", slug: `texts-${other}` },
    ]);
});
afterAll(async () => {
  await db()
    .delete(audit)
    .where(inArray(audit.projectId, [projectId, other]));
  await db()
    .delete(projects)
    .where(inArray(projects.id, [projectId, other]));
  await sqlClient().end();
});
describe("the wording rules", () => {
  it("accepts placeholders of the key and refuses anything else in braces", () => {
    expect(textProblems(ack, "Received as #{number}.")).toEqual([]);
    expect(textProblems(ack, "Received.")).toEqual(["{number} is required"]);
    expect(textProblems(ack, "#{number} {name}")).toEqual([
      "{name} is not a placeholder of acknowledgement",
    ]);
    expect(textProblems(ack, "#{number} {")).toContain("Unmatched braces");
    expect(textProblems(ack, "#{number} }")).toContain("Unmatched braces");
    expect(textProblems("portalLink", "Go {number}")).toEqual([
      "{number} is not a placeholder of portalLink",
    ]);
    expect(textProblems("portalLink", "   ")).toEqual(["The text is empty"]);
    expect(textProblems("portalLink", "x".repeat(2001))).toEqual([
      "The text is longer than 2000 characters",
    ]);
    expect(textProblems("portal.request", "It's #{number}")).toEqual([]);
    expect(textProblems("portal.request", "'{number}'")).toContain(
      "An apostrophe next to a placeholder is not allowed",
    );
  });
  it("fills placeholders, serves the built-in wording by language and falls back for other languages", () => {
    expect(fillText("a #{number} b {unknown}", { number: 7 })).toBe("a #7 b {unknown}");
    expect(baseLanguage("de-AT")).toBe("de");
    expect(baseLanguage("fr")).toBe("en");
    expect(acknowledgementText("de", 7)).toContain("unter der Nummer #7 erfasst");
    expect(acknowledgementText("fr", 7)).toContain("recorded it as #7");
    expect(acknowledgementText("de", 7, "Own #{number}")).toBe("Own #7");
    expect(portalLinkText("de")).toBe(textKeys.portalLink.defaults.de);
    expect(portalLinkText("en", "Open it:")).toBe("Open it:");
    // The customer page's built-in wording is the catalog's, not a copy.
    expect(textKeys["portal.you"].defaults.en).toBe("You");
    expect(textKeys["portal.you"].defaults.de).toBe("Du");
  });
});
describe("setting a text", () => {
  it("applies for a person, versions every change and serves the project's own wording", async () => {
    await reset();
    const before = (await listTexts(reader, projectId)).find((entry) => entry.key === ack);
    expect(before?.languages.de).toMatchObject({ own: null, version: 0 });
    expect(before).toMatchObject({ placeholders: ["number"], required: ["number"] });
    const first = await setText(manager, projectId, ack, "de", {
      text: "Eins #{number}",
      expectedVersion: 0,
    });
    expect(first).toMatchObject({ outcome: "applied", version: 1, validated: false });
    expect(first.diff).toEqual([
      { pointer: "/texts/acknowledgement/de", from: null, to: "Eins #{number}" },
    ]);
    await setText(manager, projectId, ack, "de", { text: "Zwei #{number}", expectedVersion: 1 });
    expect((await activeTexts(projectId, "de-AT")).acknowledgement).toBe("Zwei #{number}");
    expect((await activeTexts(projectId, "en")).acknowledgement).toBeUndefined();
    const listed = (await listTexts(reader, projectId)).find((entry) => entry.key === ack);
    expect(listed?.languages.de).toMatchObject({ own: "Zwei #{number}", version: 2 });
    expect(listed?.languages.en).toMatchObject({ own: null, version: 0 });
    expect(
      (await listTextVersions(reader, projectId, ack, "de")).map((row) => [row.version, row.text]),
    ).toEqual([
      [2, "Zwei #{number}"],
      [1, "Eins #{number}"],
    ]);
    // Back to the built-in wording is a version as well.
    await setText(manager, projectId, ack, "de", { text: null, expectedVersion: 2 });
    expect((await activeTexts(projectId, "de")).acknowledgement).toBeUndefined();
    expect((await listTextVersions(reader, projectId, ack, "de"))[0]).toMatchObject({
      version: 3,
      text: null,
    });
    const [entry] = await db().select().from(audit).where(eq(audit.targetId, "acknowledgement:de"));
    expect(entry).toMatchObject({ action: "text.set", actorId: manager.id });
  });
  it("does nothing when the wording is unchanged, and refuses a stale version", async () => {
    await reset();
    expect(
      await setText(manager, projectId, ack, "en", { text: null, expectedVersion: 0 }),
    ).toMatchObject({ outcome: "unchanged", version: 0 });
    await setText(manager, projectId, ack, "en", { text: "One #{number}", expectedVersion: 0 });
    expect(
      await setText(manager, projectId, ack, "en", { text: "One #{number}", expectedVersion: 1 }),
    ).toMatchObject({ outcome: "unchanged", version: 1 });
    await expect(
      setText(manager, projectId, ack, "en", { text: "Two #{number}", expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: "stale_version" });
    expect(await listTextVersions(reader, projectId, ack, "en")).toHaveLength(1);
  });
  it("refuses unknown keys and languages, and wording that breaks the rules, naming the field", async () => {
    await reset();
    const issues = async (key: string, language: string, text: string | null) => {
      const error = await setText(manager, projectId, key, language, {
        text,
        expectedVersion: 0,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ZodError);
      return (error as ZodError).issues.map((issue) => issue.path.join("/"));
    };
    expect(await issues("nothing", "de", "x")).toEqual(["key"]);
    expect(await issues(ack, "fr", "x #{number}")).toEqual(["language"]);
    expect(await issues(ack, "de", "no placeholder")).toEqual(["text"]);
    expect(await issues(ack, "de", "#{number} {bad}")).toEqual(["text"]);
    await expect(
      setText(manager, projectId, ack, "de", { text: "x #{number}", expectedVersion: -1 }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      setText(manager, projectId, ack, "de", { text: 5, expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await listTextVersions(reader, projectId, ack, "de")).toEqual([]);
  });
  it("needs config.write, and answers not_found without config.read or for another project", async () => {
    await reset();
    const body = { text: "x #{number}", expectedVersion: 0 };
    await expect(setText(reader, projectId, ack, "de", body)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(setText(plain, projectId, ack, "de", body)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(setText(elsewhere, projectId, ack, "de", body)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(listTexts(plain, projectId)).rejects.toMatchObject({ code: "not_found" });
    await expect(listTextVersions(elsewhere, projectId, ack, "de")).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("validates without writing, and a repeated request has the effect of one", async () => {
    await reset();
    expect(
      await setText(
        manager,
        projectId,
        ack,
        "de",
        { text: "V #{number}", expectedVersion: 0 },
        { validate: true },
      ),
    ).toMatchObject({ outcome: "applied", validated: true, changeId: null });
    expect(await listTextVersions(reader, projectId, ack, "de")).toEqual([]);
    const body = { text: "Once #{number}", expectedVersion: 0, idempotencyKey: randomUUID() };
    const first = await setText(manager, projectId, ack, "de", body);
    expect(await setText(manager, projectId, ack, "de", body)).toEqual(first);
    expect(await listTextVersions(reader, projectId, ack, "de")).toHaveLength(1);
    await expect(setText(agent, projectId, ack, "de", body)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });
});
describe("an agent under the review policy", () => {
  it("proposes, and a person activates it; a proposal on an older version is refused", async () => {
    await reset();
    const proposed = await setText(agent, projectId, ack, "de", {
      text: "Agent #{number}",
      expectedVersion: 0,
    });
    expect(proposed).toMatchObject({ outcome: "proposed", version: 0 });
    expect((await activeTexts(projectId, "de")).acknowledgement).toBeUndefined();
    await expect(
      decideConfigChange(agent, proposed.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await decideConfigChange(manager, proposed.changeId ?? "", { decision: "approve" }),
    ).toMatchObject({ status: "applied", version: 1 });
    expect((await activeTexts(projectId, "de")).acknowledgement).toBe("Agent #{number}");
    const late = await setText(agent, projectId, ack, "de", {
      text: "Later #{number}",
      expectedVersion: 1,
    });
    await setText(manager, projectId, ack, "de", { text: "Person #{number}", expectedVersion: 1 });
    await expect(
      decideConfigChange(manager, late.changeId ?? "", { decision: "approve" }),
    ).rejects.toMatchObject({ code: "stale_version" });
    expect((await activeTexts(projectId, "de")).acknowledgement).toBe("Person #{number}");
    const rejected = await setText(agent, projectId, ack, "de", {
      text: "No #{number}",
      expectedVersion: 2,
    });
    await decideConfigChange(manager, rejected.changeId ?? "", { decision: "reject" });
    expect((await activeTexts(projectId, "de")).acknowledgement).toBe("Person #{number}");
  });
  it("applies at once under the direct policy", async () => {
    await reset();
    await putConfig(manager, projectId, {
      config: { ...(await getConfig(manager, projectId)).config, approvalPolicy: "direct" },
      expectedVersion: 1,
    });
    expect(
      await setText(agent, projectId, ack, "de", { text: "Direct #{number}", expectedVersion: 0 }),
    ).toMatchObject({ outcome: "applied" });
    expect((await activeTexts(projectId, "de")).acknowledgement).toBe("Direct #{number}");
  });
});
