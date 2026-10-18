// Isolated browser-test data inside the private development stack. Every run
// gets its own operator and projects under an `e2e-<run>` prefix, so tests do
// not touch the development desk and parallel browsers do not share tickets.
//   setup                     prints the fixture as JSON on stdout
//   teardown <run>            deletes everything created for that run
//   user-count <email>        number of aidesk users with that email
//   disable <email>           deactivates a fixture user
//   revoke-sessions <email>   deletes a fixture user's sessions
//   github-source <projectId> gives a fixture project a repository that refuses every request
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword, symmetricEncrypt } from "better-auth/crypto";
import { eq, inArray, like, or } from "drizzle-orm";
import { db, sqlClient } from "../src/server/db";
import {
  account,
  audit,
  connections,
  ingress,
  jobs,
  memberships,
  messages,
  projectExports,
  projects,
  session,
  tickets,
  twoFactor,
  user,
} from "../src/server/db/schema";
import { actions, type Action } from "../src/domain/permissions";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
import { sweepObjects } from "../src/server/object-sweep";
import { deleteObjects } from "../src/server/storage";
if (process.env.DEV_BOOTSTRAP !== "true" || process.env.NODE_ENV !== "development")
  throw new Error("Browser-test fixtures are restricted to private development.");
const fixtureProjects: { key: string; label: string; grant: Action[] | null; language: string }[] =
  [
    { key: "alpha", label: "Alpha", grant: [...actions], language: "en" },
    { key: "beta", label: "Beta", grant: ["project.read", "ticket.read"], language: "de" },
    { key: "hidden", label: "Hidden", grant: null, language: "en" },
    // A project for a test that changes what a project has, such as a repository, so that no other
    // test finds the project different.
    { key: "gamma", label: "Gamma", grant: [...actions], language: "en" },
  ];
async function setup() {
  const run = randomBytes(4).toString("hex");
  const prefix = `e2e-${run}`;
  const email = `${prefix}-operator@aidesk.local`;
  const password = randomBytes(16).toString("hex");
  const userId = randomUUID();
  const hashed = await hashPassword(password);
  // Owners need TOTP for password sign-in; the tests compute codes from this
  // secret, and the backup codes cover single use.
  const totpSecret = randomBytes(24).toString("base64url");
  const backupCodes = ["e2e01-aaaaa", "e2e02-bbbbb"];
  const authSecret = process.env.BETTER_AUTH_SECRET ?? "";
  const plain = `${prefix}-plain@aidesk.local`;
  const plainId = randomUUID();
  const result = await db().transaction(async (tx) => {
    await tx.insert(user).values({
      id: userId,
      name: `E2E operator ${run}`,
      email,
      emailVerified: true,
      owner: true,
      twoFactorEnabled: true,
    });
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: hashed,
    });
    await tx.insert(twoFactor).values({
      id: randomUUID(),
      userId,
      secret: await symmetricEncrypt({ key: authSecret, data: totpSecret }),
      backupCodes: await symmetricEncrypt({ key: authSecret, data: JSON.stringify(backupCodes) }),
      verified: true,
    });
    // A non-owner with a password, which must not be able to use it.
    await tx
      .insert(user)
      .values({ id: plainId, name: `E2E plain ${run}`, email: plain, emailVerified: true });
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: plainId,
      providerId: "credential",
      userId: plainId,
      password: hashed,
    });
    const created: Record<string, { id: string; name: string; tickets: string[] }> = {};
    for (const { key, label, grant, language } of fixtureProjects) {
      const name = `E2E ${label} ${run}`;
      const [project] = await tx
        .insert(projects)
        .values({ slug: `${prefix}-${key}`, name, color: "#5972ed", defaultLanguage: language })
        .returning();
      if (!project) throw new Error("Project creation failed");
      if (grant)
        await tx.insert(memberships).values({ userId, projectId: project.id, actions: grant });
      const [outgoing] = await tx
        .insert(connections)
        .values({
          projectId: project.id,
          kind: "smtp",
          name: "Development Mailpit",
          direction: "outbound",
          status: "ready",
          config: {
            host: process.env.DEV_SMTP_HOST ?? "mailpit",
            port: Number(process.env.DEV_SMTP_PORT ?? 1025),
            secure: false,
            from: `${prefix}-${key}@support.local`,
            replyTo: `${prefix}-${key}@support.local`,
            developmentOnly: true,
          },
        })
        .returning();
      if (!outgoing) throw new Error("Outbound connection creation failed");
      await tx
        .update(projects)
        .set({ settings: { e2eFixture: run, outboundConnectionId: outgoing.id } })
        .where(eq(projects.id, project.id));
      // Inbound mail for this project arrives in its own GreenMail mailbox.
      await tx.insert(connections).values({
        projectId: project.id,
        kind: "imap",
        name: "Development GreenMail",
        direction: "inbound",
        status: "ready",
        config: {
          host: process.env.DEV_IMAP_HOST ?? "greenmail",
          port: Number(process.env.DEV_IMAP_PORT ?? 3143),
          secure: false,
          user: `${prefix}-${key}@support.local`,
          mailbox: "INBOX",
          developmentOnly: true,
        },
        secretCiphertext: seal(JSON.stringify({ pass: "development" }), env().ENCRYPTION_KEY),
      });
      const ids: string[] = [];
      for (const index of ["1", "2"]) {
        const [ticket] = await tx
          .insert(tickets)
          .values({
            projectId: project.id,
            subject: `${name} request ${index}`,
            requesterEmail: `${prefix}-${key}-${index}@example.test`,
            requesterName: `Customer ${index}`,
            language,
            pendingSince: new Date(Date.now() - Number(index) * 30 * 3_600_000),
          })
          .returning();
        if (!ticket) throw new Error("Ticket creation failed");
        await tx.insert(messages).values({
          ticketId: ticket.id,
          authorType: "customer",
          authorName: `Customer ${index}`,
          authorEmail: ticket.requesterEmail,
          markdown: `Customer message ${index} for ${name}.`,
          language,
          receivedMessageId: `<${prefix}-${key}-${index}@example.test>`,
        });
        ids.push(ticket.id);
      }
      created[key] = { id: project.id, name, tickets: ids };
    }
    return created;
  });
  // Operators who sign in through the development IdP. Their IdP accounts are
  // created by the browser tests through the Keycloak admin API.
  const sso = {
    oidc: `${prefix}-oidc@oidc.aidesk.test`,
    saml: `${prefix}-saml@saml.aidesk.test`,
    stranger: `${prefix}-stranger@oidc.aidesk.test`,
  };
  const alpha = result.alpha;
  if (!alpha) throw new Error("Alpha project missing");
  await db().transaction(async (tx) => {
    for (const operator of [sso.oidc, sso.saml]) {
      const id = randomUUID();
      await tx
        .insert(user)
        .values({ id, name: `E2E SSO ${run}`, email: operator, emailVerified: true });
      await tx
        .insert(memberships)
        .values({ userId: id, projectId: alpha.id, actions: [...actions] });
    }
  });
  return { run, prefix, email, password, totpSecret, backupCodes, plain, projects: result, sso };
}
async function teardown(run: string) {
  if (!/^[a-f0-9]{8}$/.test(run)) throw new Error("Invalid run identifier.");
  const prefix = `e2e-${run}`;
  const runProjects = await db()
    .select({ id: projects.id })
    .from(projects)
    .where(like(projects.slug, `${prefix}-%`));
  const runUsers = await db()
    .select({ id: user.id })
    .from(user)
    .where(like(user.email, `${prefix}-%`));
  const projectIds = runProjects.map((project) => project.id);
  const userIds = runUsers.map((entry) => entry.id);
  await db().transaction(async (tx) => {
    if (projectIds.length) {
      await tx.delete(jobs).where(inArray(jobs.projectId, projectIds));
      await tx.delete(ingress).where(inArray(ingress.projectId, projectIds));
      await tx.delete(tickets).where(inArray(tickets.projectId, projectIds));
    }
    if (projectIds.length || userIds.length)
      await tx
        .delete(audit)
        .where(
          or(
            projectIds.length ? inArray(audit.projectId, projectIds) : undefined,
            userIds.length ? inArray(audit.actorId, userIds) : undefined,
          ),
        );
    if (projectIds.length) await tx.delete(projects).where(inArray(projects.id, projectIds));
    if (userIds.length) await tx.delete(user).where(inArray(user.id, userIds));
  });
  // The exports that the run made, of its projects and of the ones that it deleted, with their files.
  const made = await db()
    .select({ id: projectExports.id, key: projectExports.objectKey })
    .from(projectExports)
    .where(
      or(
        projectIds.length ? inArray(projectExports.projectId, projectIds) : undefined,
        userIds.length ? inArray(projectExports.createdBy, userIds) : undefined,
      ),
    );
  if (made.length) {
    await deleteObjects(made.map((entry) => entry.key));
    await db()
      .delete(projectExports)
      .where(
        inArray(
          projectExports.id,
          made.map((entry) => entry.id),
        ),
      );
  }
  // The objects of the deleted projects stay in the storage after a cascade. They are
  // named by project, so nothing else uses them, and the sweep removes them now instead
  // of leaving them to the daily one (a run of the suite leaves thousands).
  for (const id of projectIds)
    for (const area of ["attachments", "inbound"])
      await sweepObjects({ prefix: `${area}/${id}/`, graceMs: 0, remove: true });
  return { run, projects: projectIds.length, users: userIds.length };
}
function fixtureEmail(value: string | undefined): string {
  if (!value || !/^e2e-[a-f0-9]{8}-[a-z]+@[a-z.]+$/.test(value))
    throw new Error("Only fixture users can be changed.");
  return value;
}
async function userCount(email: string) {
  return { count: (await db().select().from(user).where(eq(user.email, email))).length };
}
async function disable(email: string) {
  await db().update(user).set({ active: false }).where(eq(user.email, email));
  return { disabled: email };
}
async function revokeSessions(email: string) {
  const [target] = await db().select().from(user).where(eq(user.email, email));
  if (target) await db().delete(session).where(eq(session.userId, target.id));
  return { revoked: email };
}
// A repository for a fixture project, as a ready connection whose address is the app itself: it
// answers every request of the API of GitHub with an error, so a test sees how a refusal looks.
async function githubSource(projectId: string) {
  const [project] = await db().select().from(projects).where(eq(projects.id, projectId));
  if (!project?.slug.startsWith("e2e-")) throw new Error("Only fixture projects can be changed.");
  const [row] = await db()
    .insert(connections)
    .values({
      projectId,
      kind: "github",
      direction: "knowledge",
      name: "Fixture repositories",
      status: "ready",
      config: {
        repositories: ["acme/app"],
        endpoint: "http://localhost:3000/api/health/none",
        developmentOnly: true,
      },
      secretCiphertext: seal(JSON.stringify({ token: "ghp-fixture" }), env().ENCRYPTION_KEY),
    })
    .returning({ id: connections.id });
  return { connectionId: row?.id };
}
const [command, argument] = process.argv.slice(2);
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
try {
  if (command === "setup") write(await setup());
  else if (command === "teardown" && argument) write(await teardown(argument));
  else if (command === "user-count") write(await userCount(fixtureEmail(argument)));
  else if (command === "disable") write(await disable(fixtureEmail(argument)));
  else if (command === "revoke-sessions") write(await revokeSessions(fixtureEmail(argument)));
  else if (command === "github-source" && argument) write(await githubSource(argument));
  else
    throw new Error(
      "Usage: e2e-fixture.ts setup | teardown <run> | user-count|disable|revoke-sessions <email>",
    );
} finally {
  await sqlClient().end();
}
