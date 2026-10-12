import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, ingress, jobs, messages, projects, tickets } from "../src/server/db/schema";
import { acceptInbound, processIngress } from "../src/server/inbound";
import { setProjectSettings } from "../src/server/operations";
import { initializeStorage } from "../src/server/storage";
import { channelOf, channels, implementedChannels } from "../src/domain/channels";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const manager: Principal = {
  id: `manager-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: ["project.read", "project.manage"] }],
};
function mail(text: string) {
  return Buffer.from(
    [
      "From: Kim <kim@example.test>",
      "To: support@example.test",
      `Subject: ${text}`,
      `Message-ID: <${randomUUID()}@example.test>`,
      "Content-Type: text/plain",
      "",
      text,
      "",
    ].join("\r\n"),
  );
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Channels", slug: `channels-${projectId}` },
      { id: otherProject, name: "Other", slug: `channels-${otherProject}` },
    ]);
});
afterAll(async () => {
  const ids = [projectId, otherProject];
  await db().delete(jobs).where(inArray(jobs.projectId, ids));
  await db().delete(ingress).where(inArray(ingress.projectId, ids));
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("identifiers of an adapter", () => {
  it("never let the same key of another project swallow a message", async () => {
    const key = `adapter:${randomUUID()}`;
    const first = await acceptInbound({
      projectId,
      connectionId: null,
      externalKey: key,
      raw: mail("For the first project"),
    });
    const second = await acceptInbound({
      projectId: otherProject,
      connectionId: null,
      externalKey: key,
      raw: mail("For the second project"),
    });
    expect(second.duplicate).toBe(false);
    expect(second.ingressId).not.toBe(first.ingressId);
    expect(await processIngress(second.ingressId)).toBe("created");
    const [entry] = await db().select().from(ingress).where(eq(ingress.id, second.ingressId));
    const [ticket] = await db()
      .select()
      .from(tickets)
      .where(eq(tickets.id, entry?.ticketId ?? ""));
    expect(ticket).toMatchObject({ projectId: otherProject, subject: "For the second project" });
    // Counter-probe: within one project the same key is still one message.
    const again = await acceptInbound({
      projectId,
      connectionId: null,
      externalKey: key,
      raw: mail("Redelivered"),
    });
    expect(again).toEqual({ ingressId: first.ingressId, duplicate: true });
    expect(await db().select().from(ingress).where(eq(ingress.externalKey, key))).toHaveLength(2);
    expect(
      await db()
        .select()
        .from(jobs)
        .where(eq(jobs.dedupKey, `ingest:${first.ingressId}`)),
    ).toHaveLength(1);
  });
  it("keeps accounts of one project apart through the connection in the key", async () => {
    const raw = mail("Same position, two accounts");
    const [a, b] = await Promise.all(
      [randomUUID(), randomUUID()].map((connection) =>
        acceptInbound({
          projectId,
          connectionId: null,
          externalKey: `imap:${connection}:1:7`,
          raw,
        }),
      ),
    );
    expect(a?.ingressId).not.toBe(b?.ingressId);
    // The same message arriving on both is still one ticket: the core deduplicates by Message-ID.
    const outcomes = [
      await processIngress(a?.ingressId ?? ""),
      await processIngress(b?.ingressId ?? ""),
    ];
    expect(outcomes).toEqual(["created", "duplicate"]);
  });
});
describe("channel changes", () => {
  it("are not possible through project settings", async () => {
    await expect(
      setProjectSettings(manager, projectId, { outboundConnectionId: randomUUID() }),
    ).rejects.toThrow();
    const [row] = await db()
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId));
    expect(row?.settings).not.toHaveProperty("outboundConnectionId");
    expect(await setProjectSettings(manager, projectId, { acknowledgements: false })).toEqual({
      acknowledgements: false,
    });
  });
});
describe("channel registry", () => {
  it("offers email only and keeps messengers reserved", () => {
    expect(implementedChannels()).toEqual(["email"]);
    for (const reserved of ["whatsapp", "telegram", "signal"] as const)
      expect(channels[reserved]).toEqual({ implemented: false });
    expect(channelOf("imap", "inbound")).toBe("email");
    expect(channelOf("cloudflare", "inbound")).toBe("email");
    expect(channelOf("smtp", "outbound")).toBe("email");
    expect(channelOf("cloudflare", "outbound")).toBe("email");
    // A transport is only valid in the direction it was built for.
    expect(channelOf("imap", "outbound")).toBeNull();
    expect(channelOf("smtp", "inbound")).toBeNull();
    expect(channelOf("whatsapp", "outbound")).toBeNull();
    expect(channelOf("", "inbound")).toBeNull();
  });
  it("matches what the worker really dispatches and polls", () => {
    const source = readFileSync("src/worker/jobs.ts", "utf8");
    const sending = source.slice(
      source.indexOf("export async function runNext"),
      source.indexOf("export async function runIngest"),
    );
    const sends = [...sending.matchAll(/connection\.kind === "([a-z]+)"/g)].map(
      (match) => match[1],
    );
    expect([...new Set(sends)].sort()).toEqual([...channels.email.outbound].sort());
    const polled = /inArray\(connections\.kind, \[([^\]]*)\]\)/.exec(source)?.[1] ?? "";
    expect([...polled.matchAll(/"([a-z]+)"/g)].map((match) => match[1]).sort()).toEqual(
      [...channels.email.inbound].sort(),
    );
  });
  it("does not show a messenger anywhere in the interface or its texts", () => {
    for (const file of [
      "src/i18n/en.json",
      "src/i18n/de.json",
      "src/components/desk.tsx",
      "src/components/settings.tsx",
      "src/app/page.tsx",
    ]) {
      const text = readFileSync(file, "utf8").toLowerCase();
      for (const name of ["whatsapp", "telegram", "signal-cli"])
        expect(text, `${file}: ${name}`).not.toContain(name);
    }
  });
  it("counter-probe: the parity check sees a transport the registry lacks", () => {
    const source =
      'if (connection.kind === "cloudflare") {} else if (connection.kind === "telegram") {}';
    const sends = [...source.matchAll(/connection\.kind === "([a-z]+)"/g)].map((match) => match[1]);
    expect([...new Set(sends)].sort()).not.toEqual([...channels.email.outbound].sort());
  });
});
describe("messages keep their own identity", () => {
  it("records the sender of each message on the message, not only on the ticket", async () => {
    const first = await acceptInbound({
      projectId,
      connectionId: null,
      externalKey: `k:${randomUUID()}`,
      raw: mail("Identity"),
    });
    await processIngress(first.ingressId);
    const [entry] = await db().select().from(ingress).where(eq(ingress.id, first.ingressId));
    const [message] = await db()
      .select()
      .from(messages)
      .where(eq(messages.ticketId, entry?.ticketId ?? ""));
    expect(message).toMatchObject({ authorType: "customer", authorEmail: "kim@example.test" });
  });
});
