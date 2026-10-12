import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { audit, messages, participants, projects, tickets } from "../src/server/db/schema";
import {
  getPortalTicket,
  issuePortalGrant,
  resolvePortalGrant,
  revokePortalGrant,
} from "../src/server/portal";
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
