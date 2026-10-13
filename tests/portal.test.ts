import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, messages, participants, projects, tickets } from "../src/server/db/schema";
import {
  getPortalTicket,
  issuePortalGrant,
  portalReply,
  resolvePortalGrant,
  revokePortalGrant,
} from "../src/server/portal";
import { POST as portalRoute } from "../src/app/api/portal/reply/route";
import { env } from "../src/server/env";
import type { Principal } from "../src/domain/permissions";
const projectId = randomUUID();
const otherProject = randomUUID();
const staff: Principal = {
  id: `staff-${projectId}`,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: ["project.read", "ticket.read", "ticket.reply"] }],
};
const reader: Principal = {
  ...staff,
  id: `reader-${projectId}`,
  grants: [{ projectId, actions: ["project.read", "ticket.read"] }],
};
const outsider: Principal = {
  ...staff,
  id: `outsider-${projectId}`,
  grants: [{ projectId: otherProject, actions: ["ticket.read", "ticket.reply"] }],
};
async function ticket(project = projectId, email = "alex@example.test") {
  const [created] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject: "Portal",
      requesterEmail: email,
      requesterName: "Alex",
      language: "en",
    })
    .returning();
  if (!created) throw new Error("ticket");
  // Rows of one insert share the transaction time, so the order is set explicitly.
  let tick = Date.now() - 60_000;
  const base = {
    ticketId: created.id,
    language: "en",
    get createdAt() {
      tick += 1000;
      return new Date(tick);
    },
  };
  await db()
    .insert(messages)
    .values([
      {
        ...base,
        authorType: "customer",
        authorName: "Alex",
        authorEmail: email,
        markdown: "Question",
        deliveryState: "received",
      },
      {
        ...base,
        authorType: "human",
        authorName: "Sam Private",
        markdown: "Public answer",
        deliveryState: "sent",
      },
      {
        ...base,
        authorType: "human",
        authorName: "Sam Private",
        markdown: "Internal note",
        internal: true,
        deliveryState: "internal",
      },
      {
        ...base,
        authorType: "human",
        authorName: "Sam Private",
        markdown: "Internal note marked sent",
        internal: true,
        deliveryState: "sent",
      },
      {
        ...base,
        authorType: "human",
        authorName: "Sam Private",
        markdown: "Queued answer",
        deliveryState: "queued",
      },
      {
        ...base,
        authorType: "human",
        authorName: "Sam Private",
        markdown: "Answer in review",
        deliveryState: "review",
        source: { deliveryError: "bounced" },
      },
    ]);
  return created.id;
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await db()
    .insert(projects)
    .values([
      { id: projectId, name: "Support Team", slug: `portal-${projectId}` },
      { id: otherProject, name: "Other", slug: `portal-${otherProject}` },
    ]);
});
afterAll(async () => {
  const ids = [projectId, otherProject];
  await db().delete(tickets).where(inArray(tickets.projectId, ids));
  await db().delete(audit).where(inArray(audit.projectId, ids));
  await db().delete(projects).where(inArray(projects.id, ids));
  await sqlClient().end();
});
describe("portal grants", () => {
  it("lets the holder of a token read the public conversation of one ticket", async () => {
    const id = await ticket();
    const { token, expiresAt } = await issuePortalGrant(staff, id);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    // Only the hash is stored.
    const [stored] = await db().select().from(participants).where(eq(participants.ticketId, id));
    expect(stored).toMatchObject({ email: "alex@example.test", verified: true });
    expect(stored?.portalTokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(token);
    const view = await getPortalTicket(token);
    expect(view.ticket).toMatchObject({ subject: "Portal", status: "open" });
    expect(view.messages.map((message) => message.markdown)).toEqual(["Question", "Public answer"]);
    expect(view.messages.map((message) => message.from)).toEqual(["you", "team"]);
    // Staff names, addresses and internals do not leave.
    const text = JSON.stringify(view);
    for (const hidden of [
      "marked sent",
      "Sam Private",
      "Internal note",
      "Queued answer",
      "Answer in review",
      "deliveryError",
      "authorEmail",
      "rawObject",
    ])
      expect(text).not.toContain(hidden);
    expect(view.messages[1]?.authorName).toBe("Support Team");
    expect(
      await db()
        .select()
        .from(audit)
        .where(and(eq(audit.targetId, id), eq(audit.action, "portal.grant"))),
    ).toHaveLength(1);
  });
  it("keeps grants isolated to their ticket and project", async () => {
    const first = await ticket();
    const second = await ticket();
    const foreign = await ticket(otherProject);
    const a = await issuePortalGrant(staff, first);
    const b = await issuePortalGrant(staff, second);
    // The same address in the same project has one grant per ticket.
    expect((await resolvePortalGrant(a.token))?.ticketId).toBe(first);
    expect((await resolvePortalGrant(b.token))?.ticketId).toBe(second);
    expect(a.token).not.toBe(b.token);
    // A grant of the other project does not exist for staff of this one, and
    // a token never reaches into another project's ticket.
    await expect(issuePortalGrant(staff, foreign)).rejects.toMatchObject({ code: "not_found" });
    const other = await issuePortalGrant(outsider, foreign);
    expect((await resolvePortalGrant(other.token))?.projectId).toBe(otherProject);
    expect(JSON.stringify(await getPortalTicket(other.token))).not.toContain("Support Team");
    // Revoking one ticket leaves the other valid.
    await revokePortalGrant(staff, first);
    expect(await resolvePortalGrant(a.token)).toBeNull();
    expect(await resolvePortalGrant(b.token)).not.toBeNull();
  });
  it("refuses tokens that are unknown, malformed, expired, revoked, unverified or replaced", async () => {
    const id = await ticket();
    const { token } = await issuePortalGrant(staff, id, { days: 1 });
    expect(await resolvePortalGrant(token)).not.toBeNull();
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "short",
      "x".repeat(101),
      randomUUID().repeat(2),
      `${token}x`,
    ])
      expect(await resolvePortalGrant(bad)).toBeNull();
    await expect(getPortalTicket("nope")).rejects.toMatchObject({ code: "not_found" });
    const entry = and(eq(participants.ticketId, id));
    await db()
      .update(participants)
      .set({ grantExpiresAt: new Date(Date.now() - 1000) })
      .where(entry);
    expect(await resolvePortalGrant(token)).toBeNull();
    await db()
      .update(participants)
      .set({ grantExpiresAt: new Date(Date.now() + 60_000), verified: false })
      .where(entry);
    expect(await resolvePortalGrant(token)).toBeNull();
    await db().update(participants).set({ verified: true }).where(entry);
    expect(await resolvePortalGrant(token)).not.toBeNull();
    await db().update(participants).set({ grantExpiresAt: null }).where(entry);
    expect(await resolvePortalGrant(token)).toBeNull();
    // A new token replaces the old one for the same participant.
    const fresh = await issuePortalGrant(staff, id);
    expect(await resolvePortalGrant(token)).toBeNull();
    expect(await resolvePortalGrant(fresh.token)).not.toBeNull();
    expect(
      await db().select().from(participants).where(eq(participants.ticketId, id)),
    ).toHaveLength(1);
    // A revoked grant can be issued again.
    await revokePortalGrant(staff, id);
    expect(await resolvePortalGrant(fresh.token)).toBeNull();
    expect(await resolvePortalGrant((await issuePortalGrant(staff, id)).token)).not.toBeNull();
  });
  it("stops serving a ticket that moved to junk", async () => {
    const id = await ticket();
    const { token } = await issuePortalGrant(staff, id);
    await db().update(tickets).set({ junkAt: new Date() }).where(eq(tickets.id, id));
    expect(await resolvePortalGrant(token)).toBeNull();
    await expect(issuePortalGrant(staff, id)).rejects.toMatchObject({ code: "conflict" });
    await db().update(tickets).set({ junkAt: null }).where(eq(tickets.id, id));
    expect(await resolvePortalGrant(token)).not.toBeNull();
  });
  it("is managed only by people who may reply in the project", async () => {
    const id = await ticket();
    await expect(issuePortalGrant(reader, id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(issuePortalGrant({ ...staff, kind: "agent" }, id)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(issuePortalGrant({ ...staff, active: false }, id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(issuePortalGrant(outsider, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(issuePortalGrant(staff, id, { days: 0 })).rejects.toThrow();
    await expect(issuePortalGrant(staff, id, { days: 91 })).rejects.toThrow();
    expect(
      await db().select().from(participants).where(eq(participants.ticketId, id)),
    ).toHaveLength(0);
    await expect(revokePortalGrant(staff, id)).rejects.toMatchObject({ code: "conflict" });
    await issuePortalGrant(staff, id);
    await expect(revokePortalGrant(reader, id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(revokePortalGrant(outsider, id)).rejects.toMatchObject({ code: "not_found" });
    expect(await revokePortalGrant(staff, id)).toEqual({ revoked: true });
    await expect(revokePortalGrant(staff, id)).rejects.toMatchObject({ code: "conflict" });
  });
});
describe("portal replies", () => {
  const german =
    "Hallo, ich habe seit gestern ein Problem mit der Anmeldung und kann mich nicht mehr einloggen. Bitte melden Sie sich, wenn Sie mehr Informationen brauchen.";
  async function open() {
    const id = await ticket();
    const { token } = await issuePortalGrant(staff, id);
    const [before] = await db().select().from(tickets).where(eq(tickets.id, id));
    return { id, token, before };
  }
  const reply = (token: string, markdown: string, idempotencyKey = randomUUID()) =>
    portalReply(token, { markdown, idempotencyKey });
  it("adds a message of the requester and gives the ticket back to the team", async () => {
    const { id, token, before } = await open();
    await db()
      .update(tickets)
      .set({ status: "waiting", pendingSince: null })
      .where(eq(tickets.id, id));
    const result = await reply(token, "  Thanks, one more thing.  ");
    expect(result.duplicate).toBe(false);
    const [after] = await db().select().from(tickets).where(eq(tickets.id, id));
    expect(after).toMatchObject({ status: "open", revision: (before?.revision ?? 0) + 1 });
    expect(after?.pendingSince).not.toBeNull();
    const [message] = await db().select().from(messages).where(eq(messages.id, result.id));
    expect(message).toMatchObject({
      ticketId: id,
      authorType: "customer",
      authorEmail: "alex@example.test",
      authorName: "Alex",
      markdown: "Thanks, one more thing.",
      deliveryState: "received",
      language: "en",
      source: { channel: "portal" },
    });
    expect(message?.rawObjectKey).toBeNull();
    // It shows in the customer's view as theirs, and in the audit.
    const view = await getPortalTicket(token);
    expect(view.messages.at(-1)).toMatchObject({
      from: "you",
      markdown: "Thanks, one more thing.",
    });
    expect(
      await db()
        .select()
        .from(audit)
        .where(and(eq(audit.targetId, id), eq(audit.action, "portal.reply"))),
    ).toHaveLength(1);
  });
  it("keeps the ticket language and records the language it was written in", async () => {
    const { id, token } = await open();
    const result = await reply(token, german);
    const [message] = await db().select().from(messages).where(eq(messages.id, result.id));
    expect(message?.language).toBe("de");
    expect(message?.source).toMatchObject({ languageDetection: { language: "de" } });
    expect((await db().select().from(tickets).where(eq(tickets.id, id)))[0]?.language).toBe("en");
  });
  it("answers a repeated submission with the same message", async () => {
    const { id, token } = await open();
    const key = randomUUID();
    const first = await reply(token, "Once", key);
    const [second, third] = await Promise.all([
      reply(token, "Once", key),
      reply(token, "Once", key),
    ]);
    expect(second).toMatchObject({ id: first.id, duplicate: true });
    expect(third).toMatchObject({ id: first.id, duplicate: true });
    const sent = await db().select().from(messages).where(eq(messages.ticketId, id));
    expect(sent.filter((message) => message.markdown === "Once")).toHaveLength(1);
    // A new key is a new message.
    expect((await reply(token, "Twice")).duplicate).toBe(false);
  });
  it("reopens a recently resolved ticket and refuses one that was closed long ago", async () => {
    const recent = await open();
    await db()
      .update(tickets)
      .set({
        status: "resolved",
        resolvedAt: new Date(Date.now() - 5 * 86_400_000),
        pendingSince: null,
      })
      .where(eq(tickets.id, recent.id));
    expect((await getPortalTicket(recent.token)).canReply).toBe(true);
    await reply(recent.token, "Still broken");
    expect((await db().select().from(tickets).where(eq(tickets.id, recent.id)))[0]).toMatchObject({
      status: "open",
      resolvedAt: null,
    });
    const old = await open();
    await db()
      .update(tickets)
      .set({ status: "resolved", resolvedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(tickets.id, old.id));
    expect((await getPortalTicket(old.token)).canReply).toBe(false);
    await expect(reply(old.token, "Too late")).rejects.toMatchObject({ code: "conflict" });
    await db().update(tickets).set({ resolvedAt: null }).where(eq(tickets.id, old.id));
    expect((await getPortalTicket(old.token)).canReply).toBe(false);
    await expect(reply(old.token, "No time")).rejects.toMatchObject({ code: "conflict" });
    expect(
      await db()
        .select()
        .from(messages)
        .where(and(eq(messages.ticketId, old.id), eq(messages.markdown, "Too late"))),
    ).toHaveLength(0);
  });
  it("is limited to twenty replies an hour per grant", async () => {
    const { id, token } = await open();
    for (let index = 0; index < 20; index += 1) await reply(token, `Reply ${String(index)}`);
    await expect(reply(token, "One too many")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
    // A grant of another ticket is counted on its own.
    const other = await open();
    expect((await reply(other.token, "Fine")).duplicate).toBe(false);
    expect((await db().select().from(messages).where(eq(messages.ticketId, id))).length).toBe(26);
  });
  it("refuses unknown, revoked, expired tokens, junk tickets and malformed input", async () => {
    const { id, token } = await open();
    for (const bad of [undefined, "", "short", `${token}x`, randomUUID().repeat(2)])
      await expect(reply(bad!, "Hi")).rejects.toMatchObject({ code: "not_found" });
    for (const input of [
      {},
      { markdown: "", idempotencyKey: randomUUID() },
      { markdown: "   ", idempotencyKey: randomUUID() },
      { markdown: "x".repeat(20_001), idempotencyKey: randomUUID() },
      { markdown: "Hi", idempotencyKey: "not-a-uuid" },
      { markdown: "Hi", idempotencyKey: randomUUID(), authorEmail: "eve@example.test" },
      { markdown: "Hi", idempotencyKey: randomUUID(), internal: true },
    ])
      await expect(portalReply(token, input)).rejects.toThrow();
    await db().update(tickets).set({ junkAt: new Date() }).where(eq(tickets.id, id));
    await expect(reply(token, "Junk")).rejects.toMatchObject({ code: "not_found" });
    await db().update(tickets).set({ junkAt: null }).where(eq(tickets.id, id));
    await revokePortalGrant(staff, id);
    await expect(reply(token, "Revoked")).rejects.toMatchObject({ code: "not_found" });
    const fresh = await issuePortalGrant(staff, id);
    await db()
      .update(participants)
      .set({ grantExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(participants.ticketId, id));
    await expect(reply(fresh.token, "Expired")).rejects.toMatchObject({ code: "not_found" });
    expect(
      await db()
        .select()
        .from(messages)
        .where(and(eq(messages.ticketId, id), eq(messages.authorType, "customer"))),
    ).toHaveLength(1);
  });
  it("cannot be used to write into another ticket or to claim another author", async () => {
    const first = await open();
    const second = await open();
    await reply(first.token, "Mine");
    const theirs = await db().select().from(messages).where(eq(messages.ticketId, second.id));
    expect(theirs.some((message) => message.markdown === "Mine")).toBe(false);
    expect(
      (await getPortalTicket(second.token)).messages.map((message) => message.markdown),
    ).not.toContain("Mine");
  });
});
describe("portal reply route", () => {
  const origin = new URL(env().APP_URL).origin;
  const call = (body: string, headers: Record<string, string> = { origin }) =>
    portalRoute(
      new Request(`${origin}/api/portal/reply`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
    );
  it("answers requests from the application's own pages only", async () => {
    const id = await ticket();
    const { token } = await issuePortalGrant(staff, id);
    const body = JSON.stringify({ token, markdown: "Hello", idempotencyKey: randomUUID() });
    expect((await call(body, {})).status).toBe(403);
    expect((await call(body, { origin: "https://evil.test" })).status).toBe(403);
    // A bearer header does not stand in for the origin.
    expect((await call(body, { authorization: "Bearer x" })).status).toBe(403);
    const ok = await call(body);
    expect(ok.status).toBe(201);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toMatchObject({ duplicate: false });
  });
  it("maps failures to stable answers without saying why a link fails", async () => {
    const id = await ticket();
    const { token } = await issuePortalGrant(staff, id);
    const key = randomUUID();
    expect((await call("{broken")).status).toBe(400);
    expect((await call(JSON.stringify({ token, markdown: "", idempotencyKey: key }))).status).toBe(
      400,
    );
    expect(
      (await call(JSON.stringify({ token, markdown: "Hi", idempotencyKey: key, internal: true })))
        .status,
    ).toBe(400);
    const unknown = await call(
      JSON.stringify({ token: "x".repeat(43), markdown: "Hi", idempotencyKey: key }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });
    await revokePortalGrant(staff, id);
    const revoked = await call(JSON.stringify({ token, markdown: "Hi", idempotencyKey: key }));
    expect(revoked.status).toBe(404);
    expect(await revoked.json()).toEqual({ error: "not_found" });
    const closed = await ticket();
    const grant = await issuePortalGrant(staff, closed);
    await db()
      .update(tickets)
      .set({ status: "resolved", resolvedAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(eq(tickets.id, closed));
    expect(
      (
        await call(
          JSON.stringify({ token: grant.token, markdown: "Hi", idempotencyKey: randomUUID() }),
        )
      ).status,
    ).toBe(409);
  });
});
