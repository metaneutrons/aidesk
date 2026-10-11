// Isolated browser-test data inside the private development stack. Every run
// gets its own operator and projects under an `e2e-<run>` prefix, so tests do
// not touch the development desk and parallel browsers do not share tickets.
//   setup             prints the fixture as JSON on stdout
//   teardown <run>    deletes everything created for that run
import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
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
  projects,
  tickets,
  user,
} from "../src/server/db/schema";
import { actions, type Action } from "../src/domain/permissions";
if (process.env.DEV_BOOTSTRAP !== "true" || process.env.NODE_ENV !== "development")
  throw new Error("Browser-test fixtures are restricted to private development.");
const fixtureProjects: { key: string; label: string; grant: Action[] | null; language: string }[] =
  [
    { key: "alpha", label: "Alpha", grant: [...actions], language: "en" },
    { key: "beta", label: "Beta", grant: ["project.read", "ticket.read"], language: "de" },
    { key: "hidden", label: "Hidden", grant: null, language: "en" },
  ];
async function setup() {
  const run = randomBytes(4).toString("hex");
  const prefix = `e2e-${run}`;
  const email = `${prefix}-operator@aidesk.local`;
  const password = randomBytes(16).toString("hex");
  const userId = randomUUID();
  const hashed = await hashPassword(password);
  const result = await db().transaction(async (tx) => {
    await tx.insert(user).values({
      id: userId,
      name: `E2E operator ${run}`,
      email,
      emailVerified: true,
      owner: true,
    });
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
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
        });
        ids.push(ticket.id);
      }
      created[key] = { id: project.id, name, tickets: ids };
    }
    return created;
  });
  return { run, prefix, email, password, projects: result };
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
  return { run, projects: projectIds.length, users: userIds.length };
}
const [command, argument] = process.argv.slice(2);
try {
  if (command === "setup") process.stdout.write(JSON.stringify(await setup()) + "\n");
  else if (command === "teardown" && argument)
    process.stdout.write(JSON.stringify(await teardown(argument)) + "\n");
  else throw new Error("Usage: e2e-fixture.ts setup | teardown <run>");
} finally {
  await sqlClient().end();
}
