import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { and, eq, like } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  audit,
  connections,
  jobs,
  memberships,
  projects,
  ssoProvider,
  user,
} from "../src/server/db/schema";
import { inviteOperator } from "../src/server/invitations";
import { getTestMail } from "../src/server/email-design";
import { runTestSend } from "../src/worker/jobs";
import { actionsOf } from "../src/server/grants";
import { DomainError } from "../src/server/errors";
import { invitationsPerDay } from "../src/domain/invitations";
import type { Action, Principal } from "../src/domain/permissions";
import { startFakeSmtp, type FakeSmtp } from "./support/smtp";
const run = randomUUID().slice(0, 8);
const projectId = randomUUID();
const connectionId = randomUUID();
const ids = { lead: `inv-lead-${run}`, plain: `inv-plain-${run}`, off: `inv-off-${run}` };
const domain = `inv-${run}.example.test`;
let smtp: FakeSmtp;
const held: Action[] = ["project.read", "project.manage", "ticket.read", "ticket.reply"];
const lead: Principal = {
  id: ids.lead,
  kind: "human",
  active: true,
  owner: false,
  grants: [{ projectId, actions: held }],
};
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof DomainError ? error.code : "other"),
  );
const address = (name: string) => `${name}-${randomUUID().slice(0, 6)}@${domain}`;
const body = (overrides: Record<string, unknown> = {}) => ({
  email: address("new"),
  name: "Robin Example",
  actions: ["project.read", "ticket.read"],
  ...overrides,
});
const invitations = () =>
  db()
    .select()
    .from(audit)
    .where(and(eq(audit.projectId, projectId), eq(audit.action, "operator.invite")));
const queued = async () =>
  (await db().select().from(jobs).where(eq(jobs.projectId, projectId))).filter(
    (job) => job.type === "mail.test",
  );
const settings = (values: Record<string, unknown>) =>
  db().update(projects).set({ settings: values }).where(eq(projects.id, projectId));
beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEV_BOOTSTRAP", "true");
  await migrate(db(), { migrationsFolder: "drizzle" });
  smtp = await startFakeSmtp();
  await db()
    .insert(projects)
    .values({
      id: projectId,
      name: "Invite Project",
      slug: `inv-${run}`,
      settings: { outboundConnectionId: connectionId },
    });
  await db()
    .insert(connections)
    .values({
      id: connectionId,
      projectId,
      kind: "smtp",
      name: "Fake",
      direction: "outbound",
      status: "ready",
      config: {
        host: "127.0.0.1",
        port: smtp.port,
        secure: false,
        from: "support@example.test",
        replyTo: "support@example.test",
        developmentOnly: true,
      },
    });
  await db()
    .insert(user)
    .values([
      { id: ids.lead, name: "Lead Person", email: `${ids.lead}@example.test`, emailVerified: true },
      { id: ids.plain, name: "Plain Person", email: `${ids.plain}@${domain}`, emailVerified: true },
      {
        id: ids.off,
        name: "Off Person",
        email: `${ids.off}@${domain}`,
        emailVerified: true,
        active: false,
      },
    ]);
  await db().insert(memberships).values({ userId: ids.lead, projectId, actions: held });
  await db().update(user).set({ displayName: "Lead (support)" }).where(eq(user.id, ids.lead));
});
beforeEach(async () => {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await settings({ outboundConnectionId: connectionId });
  smtp.messages.length = 0;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await smtp.close();
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(audit).where(eq(audit.projectId, projectId));
  await db().delete(ssoProvider).where(eq(ssoProvider.domain, domain));
  await db().delete(projects).where(eq(projects.id, projectId));
  // The accounts that the invitations made are the ones on the domain of this run.
  await db()
    .delete(user)
    .where(like(user.email, `%@${domain}`));
  await db().delete(user).where(eq(user.id, ids.lead));
  await sqlClient().end();
});
describe("inviting an operator by address", () => {
  it("adds a person with the rights and queues the mail, and writes an entry without the text of the mail", async () => {
    const input = body();
    const result = await inviteOperator(lead, projectId, input);
    expect(result).toMatchObject({
      created: true,
      email: input.email,
      name: "Robin Example",
      mail: "queued",
      canSignIn: false,
    });
    expect(new Set(result.actions)).toEqual(new Set(["project.read", "ticket.read"]));
    expect(new Set(await actionsOf(result.id, projectId))).toEqual(
      new Set(["project.read", "ticket.read"]),
    );
    const [account] = await db().select().from(user).where(eq(user.id, result.id));
    expect(account).toMatchObject({ email: input.email, emailVerified: true, active: true });
    expect(await queued()).toHaveLength(1);
    expect(await getTestMail(lead, result.mailId ?? "")).toMatchObject({ status: "queued" });
    const [entry] = (await invitations()).filter((row) => row.targetId === result.id);
    expect(entry?.detail).toMatchObject({ email: input.email, created: true, mail: "queued" });
  });
  it("tells the person by mail with the name of the one who invited, the project and the address of the sign-in", async () => {
    const input = body({ name: "Sam Sample" });
    const result = await inviteOperator(lead, projectId, input);
    expect(await runTestSend({ projectId })).toBe(true);
    const parsed = await simpleParser(Buffer.from(smtp.messages.at(-1) ?? ""));
    expect(parsed.to).toMatchObject({ value: [{ address: input.email }] });
    expect(parsed.subject).toBe("You were added to Invite Project");
    const text = parsed.text ?? "";
    expect(text).toContain("Hello Sam Sample");
    expect(text).toContain("Lead (support) added you as an operator of Invite Project");
    expect(text).toContain("localhost:3000");
    expect(text).toContain("no password");
    expect(await getTestMail(lead, result.mailId ?? "")).toMatchObject({ status: "succeeded" });
  });
  it("is written in German when asked, with du", async () => {
    await inviteOperator(lead, projectId, body({ language: "de" }));
    await runTestSend({ projectId });
    const parsed = await simpleParser(Buffer.from(smtp.messages.at(-1) ?? ""));
    expect(parsed.subject).toBe("Du wurdest zu Invite Project hinzugefügt");
    expect(parsed.text).toContain("hat dich als Operator");
  });
  it("adds to what an existing operator holds and leaves their name and their account alone", async () => {
    await db()
      .insert(memberships)
      .values({ userId: ids.plain, projectId, actions: ["ticket.reply"] })
      .onConflictDoUpdate({
        target: [memberships.userId, memberships.projectId],
        set: { actions: ["ticket.reply"] },
      });
    const result = await inviteOperator(
      lead,
      projectId,
      body({ email: `${ids.plain}@${domain}`.toUpperCase(), name: "Another Name" }),
    );
    expect(result).toMatchObject({ created: false, id: ids.plain, name: "Plain Person" });
    expect(new Set(result.actions)).toEqual(
      new Set(["ticket.reply", "project.read", "ticket.read"]),
    );
    const [account] = await db().select().from(user).where(eq(user.id, ids.plain));
    expect(account?.name).toBe("Plain Person");
    await db().delete(memberships).where(eq(memberships.userId, ids.plain));
  });
  it("refuses an operator who is switched off", async () => {
    expect(
      await outcome(inviteOperator(lead, projectId, body({ email: `${ids.off}@${domain}` }))),
    ).toBe("conflict");
    expect(await queued()).toHaveLength(0);
  });
  it("says whether a provider with a verified domain exists for the address", async () => {
    await db()
      .insert(ssoProvider)
      .values({
        id: `inv-${run}`,
        issuer: "https://issuer.example.test",
        providerId: `inv-${run}`,
        domain,
        domainVerified: false,
        oidcConfig: "{}",
      });
    expect((await inviteOperator(lead, projectId, body())).canSignIn).toBe(false);
    await db()
      .update(ssoProvider)
      .set({ domainVerified: true })
      .where(eq(ssoProvider.domain, domain));
    expect((await inviteOperator(lead, projectId, body())).canSignIn).toBe(true);
    expect(
      (await inviteOperator(lead, projectId, body({ email: `someone@other-${run}.example.test` })))
        .canSignIn,
    ).toBe(false);
    await db().delete(ssoProvider).where(eq(ssoProvider.domain, domain));
  });
  it("does not send a mail when it is not asked for, when there is no connection or when outgoing mail is paused", async () => {
    expect(await inviteOperator(lead, projectId, body({ sendMail: false }))).toMatchObject({
      mail: "skipped",
      mailId: null,
    });
    await settings({});
    expect(await inviteOperator(lead, projectId, body())).toMatchObject({ mail: "no_connection" });
    await settings({ outboundConnectionId: connectionId, pauseOutgoing: true });
    expect(await inviteOperator(lead, projectId, body())).toMatchObject({ mail: "paused" });
    expect(await queued()).toHaveLength(0);
    // The person is added all the same.
    expect((await invitations()).length).toBeGreaterThanOrEqual(3);
  });
  it("is not sent when the inviter no longer manages the project by the time the worker looks", async () => {
    const result = await inviteOperator(lead, projectId, body());
    await db().delete(memberships).where(eq(memberships.userId, ids.lead));
    try {
      await runTestSend({ projectId });
      expect(smtp.messages).toHaveLength(0);
      const [job] = await queued();
      expect(job).toMatchObject({ status: "review", lastErrorCode: "dispatch_grant_revoked" });
      expect(result.mailId).toBe(job?.id);
    } finally {
      await db().insert(memberships).values({ userId: ids.lead, projectId, actions: held });
    }
  });
});
describe("who may invite, and what", () => {
  it("never gives more than the person holds", async () => {
    for (const actions of [["ticket.assign"], ["project.read", "config.write"]])
      expect(await outcome(inviteOperator(lead, projectId, body({ actions })))).toBe("forbidden");
    expect(await queued()).toHaveLength(0);
  });
  it("refuses no rights at all, an unknown action, a field that is not known and an address that is not one", async () => {
    await expect(inviteOperator(lead, projectId, body({ actions: [] }))).rejects.toThrow();
    await expect(inviteOperator(lead, projectId, body({ actions: ["root"] }))).rejects.toThrow();
    await expect(inviteOperator(lead, projectId, body({ owner: true }))).rejects.toThrow();
    await expect(
      inviteOperator(lead, projectId, body({ email: "not-an-address" })),
    ).rejects.toThrow();
    await expect(inviteOperator(lead, projectId, body({ name: "  " }))).rejects.toThrow();
  });
  it("is for people who manage the project", async () => {
    const reader: Principal = { ...lead, grants: [{ projectId, actions: ["project.read"] }] };
    const elsewhere: Principal = { ...lead, grants: [{ projectId: randomUUID(), actions: held }] };
    expect(await outcome(inviteOperator(reader, projectId, body()))).toBe("not_found");
    expect(await outcome(inviteOperator(elsewhere, projectId, body()))).toBe("not_found");
    expect(await outcome(inviteOperator({ ...lead, kind: "agent" }, projectId, body()))).toBe(
      "forbidden",
    );
    expect(await outcome(inviteOperator({ ...lead, active: false }, projectId, body()))).toBe(
      "forbidden",
    );
  });
  it("is limited to a number of invitations a day for each project", async () => {
    const before = (await invitations()).length;
    await db()
      .insert(audit)
      .values(
        Array.from({ length: Math.max(invitationsPerDay - before, 0) }, () => ({
          projectId,
          actorId: ids.lead,
          action: "operator.invite",
        })),
      );
    expect(await outcome(inviteOperator(lead, projectId, body()))).toBe("rate_limited");
    // An entry of the day before does not count.
    await db()
      .update(audit)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(and(eq(audit.projectId, projectId), eq(audit.action, "operator.invite")));
    expect(await outcome(inviteOperator(lead, projectId, body()))).toBe("ok");
  });
});
