import { createHash, createHmac, randomUUID } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, getTableName, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "../src/server/db";
import {
  agents,
  attachments,
  audit,
  configChanges,
  connections,
  ingress,
  jobs,
  memberships,
  operatorGroupMembers,
  operatorGroups,
  messages,
  participants,
  portalDomains,
  projectExports,
  projects,
  projectTexts,
  session,
  tickets,
  user,
  webhooks,
} from "../src/server/db/schema";
import { auth } from "../src/server/auth";
import { identify, tokenHash } from "../src/server/principal";
import { archiveProject, restoreProject } from "../src/server/archive";
import {
  createProjectExport,
  exportKey,
  listProjectExports,
  readProjectExport,
} from "../src/server/project-export";
import { deleteProject } from "../src/server/project-delete";
import {
  deleteObjects,
  getObject,
  initializeStorage,
  listObjects,
  putObject,
} from "../src/server/storage";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
import { DomainError } from "../src/server/errors";
import { actions, type Principal } from "../src/domain/permissions";
const run = randomUUID().slice(0, 8);
const projectD = randomUUID();
const projectE = randomUUID();
const ids = {
  manager: `del-manager-${run}`,
  plain: `del-plain-${run}`,
  owner: `del-owner-${run}`,
  other: `del-other-${run}`,
};
const agentId = randomUUID();
const agentToken = `del-agent-token-${run}`;
const secrets = {
  connection: `connection-secret-${run}`,
  webhook: `webhook-secret-${run}`,
  payload: `payload-secret-${run}`,
};
const outcome = async (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof DomainError ? error.code : "other"),
  );
async function asPerson(userId: string): Promise<Principal> {
  const context = await auth().$context;
  const started = await context.internalAdapter.createSession(userId);
  const signature = createHmac("sha256", context.secret).update(started.token).digest("base64");
  const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${started.token}.${signature}`)}`;
  return identify(new Headers({ cookie }));
}
// The owner is a principal that is built here, not a row of the table of users: the tests of the setup of the
// owner remove every owner row, also those that other test files made while they run.
const ownerPrincipal: Principal = {
  id: ids.owner,
  kind: "human",
  active: true,
  owner: true,
  grants: [],
};
const asAgent = () => identify(new Headers({ authorization: `Bearer ${agentToken}` }));
const keysOf = async (prefix: string) => {
  const found: string[] = [];
  for await (const entry of listObjects(prefix)) found.push(entry.key);
  return found;
};
const objects = {
  rawD: `inbound/${projectD}/${"a".repeat(64)}.eml`,
  fileD: `attachments/${projectD}/${"b".repeat(64)}`,
  rawE: `inbound/${projectE}/${"c".repeat(64)}.eml`,
  fileE: `attachments/${projectE}/${"d".repeat(64)}`,
};
const bytesOf = {
  rawD: Buffer.from("From: kim@example.test\r\n\r\nraw mail of D"),
  fileD: Buffer.from([0, 1, 2, 250, 251, 252, 9, 9, 9]),
};
async function fill(project: string, subject: string, raw: string, file: string) {
  const [ticket] = await db()
    .insert(tickets)
    .values({
      projectId: project,
      subject,
      requesterEmail: `customer-${run}@example.test`,
      requesterName: "Customer",
      language: "en",
    })
    .returning();
  if (!ticket) throw new Error("ticket");
  const [message] = await db()
    .insert(messages)
    .values({
      ticketId: ticket.id,
      language: "en",
      authorType: "customer",
      authorName: "Customer",
      authorEmail: `customer-${run}@example.test`,
      markdown: `Question of ${subject}`,
      deliveryState: "received",
      rawObjectKey: raw,
    })
    .returning();
  if (!message) throw new Error("message");
  await db().insert(attachments).values({
    messageId: message.id,
    projectId: project,
    position: 0,
    filename: "note.bin",
    contentType: "application/octet-stream",
    size: 9,
    checksum: "x",
    objectKey: file,
  });
  await db()
    .insert(participants)
    .values({ ticketId: ticket.id, email: `customer-${run}@example.test`, verified: true });
  await db()
    .insert(ingress)
    .values({
      projectId: project,
      externalKey: `ext-${project}-${randomUUID()}`,
      rawObjectKey: raw,
      checksum: "y",
    });
  await db()
    .insert(jobs)
    .values({
      projectId: project,
      type: `del.test.${run}`,
      dedupKey: `del:${project}:${randomUUID()}`,
      payload: {},
    });
  return ticket.id;
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values([
      { id: projectD, name: `Delete D ${run}`, slug: `del-d-${run}` },
      { id: projectE, name: `Delete E ${run}`, slug: `del-e-${run}` },
    ]);
  await db()
    .insert(user)
    .values([
      { id: ids.manager, name: "Manager", email: `${ids.manager}@example.test` },
      { id: ids.plain, name: "Plain", email: `${ids.plain}@example.test` },
      { id: ids.other, name: "Other", email: `${ids.other}@example.test` },
    ]);
  await db()
    .insert(memberships)
    .values([
      { userId: ids.manager, projectId: projectD, actions: [...actions] },
      { userId: ids.plain, projectId: projectD, actions: ["project.read", "ticket.read"] },
      { userId: ids.other, projectId: projectE, actions: [...actions] },
    ]);
  // A group with a member, which the export names and the deletion removes.
  const [exported] = await db()
    .insert(operatorGroups)
    .values({
      projectId: projectD,
      name: `Group ${run}`,
      actions: ["project.read"],
      createdBy: ids.manager,
    })
    .returning({ id: operatorGroups.id });
  await db()
    .insert(operatorGroupMembers)
    .values({ groupId: exported?.id ?? "", userId: ids.plain, addedBy: ids.manager });
  await db()
    .insert(agents)
    .values({
      id: agentId,
      name: "Delete agent",
      projectId: projectD,
      actions: ["project.read", "ticket.read", "project.manage"],
      tokenHash: tokenHash(agentToken),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  await db()
    .insert(connections)
    .values({
      projectId: projectD,
      kind: "smtp",
      name: "Outgoing mail",
      direction: "outbound",
      config: { host: "smtp.example.test" },
      secretCiphertext: seal(
        JSON.stringify({ password: secrets.connection }),
        env().ENCRYPTION_KEY,
      ),
    });
  await db()
    .insert(webhooks)
    .values({
      projectId: projectD,
      name: "Hook",
      url: "https://hooks.example.test/in",
      events: ["ticket.created"],
      secretCiphertext: seal(secrets.webhook, env().ENCRYPTION_KEY),
    });
  await db()
    .insert(configChanges)
    .values({
      projectId: projectD,
      baseVersion: 1,
      status: "applied",
      proposedBy: ids.manager,
      proposerKind: "human",
      payload: { secret: secrets.payload },
      diff: [{ pointer: "/name", from: "a", to: "b" }],
    });
  await db()
    .insert(projectTexts)
    .values({
      projectId: projectD,
      key: "acknowledgement",
      language: "en",
      version: 1,
      text: "We got your mail",
      createdBy: ids.manager,
    } as typeof projectTexts.$inferInsert);
  await db()
    .insert(portalDomains)
    .values({
      projectId: projectD,
      host: `${run}.example.test`,
      token: "t",
      createdBy: ids.manager,
    });
  await putObject(objects.rawD, bytesOf.rawD, "message/rfc822");
  await putObject(objects.fileD, bytesOf.fileD, "application/octet-stream");
  await putObject(objects.rawE, Buffer.from("raw mail of E"), "message/rfc822");
  await putObject(objects.fileE, Buffer.from("file of E"), "application/octet-stream");
});
afterEach(async () => {
  await db()
    .update(projects)
    .set({ archivedAt: null, archivedBy: null })
    .where(eq(projects.id, projectD));
});
afterAll(async () => {
  const all = [projectD, projectE];
  const exported = await db()
    .select()
    .from(projectExports)
    .where(inArray(projectExports.projectId, all));
  await deleteObjects([...exported.map((row) => row.objectKey), ...Object.values(objects)]);
  await db().delete(projectExports).where(inArray(projectExports.projectId, all));
  await db().delete(ingress).where(inArray(ingress.projectId, all));
  await db().delete(jobs).where(inArray(jobs.projectId, all));
  await db().delete(tickets).where(inArray(tickets.projectId, all));
  await db().delete(audit).where(inArray(audit.projectId, all));
  await db().delete(agents).where(eq(agents.id, agentId));
  await db()
    .delete(session)
    .where(inArray(session.userId, Object.values(ids)));
  await db().delete(memberships).where(inArray(memberships.projectId, all));
  await db().delete(projects).where(inArray(projects.id, all));
  await db()
    .delete(user)
    .where(inArray(user.id, Object.values(ids)));
});
describe("the export of a project", () => {
  it("holds the rows, the settings and every object of the project and nothing of another project", async () => {
    await fill(projectD, `Subject D ${run}`, objects.rawD, objects.fileD);
    await fill(projectE, `Subject E ${run}`, objects.rawE, objects.fileE);
    const owner = ownerPrincipal;
    const made = await exportOf(owner);
    const files = unzipSync(
      new Uint8Array((await readProjectExport(owner, projectD, made.id)).content),
    );
    const text = (name: string) => strFromU8(files[name] ?? new Uint8Array());
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "manifest.json",
        "project.json",
        "tickets.ndjson",
        "messages.ndjson",
        "attachments.ndjson",
        "audit.ndjson",
        `objects/${objects.rawD}`,
        `objects/${objects.fileD}`,
      ]),
    );
    expect(text("tickets.ndjson")).toContain(`Subject D ${run}`);
    expect(text("messages.ndjson")).toContain(`Question of Subject D ${run}`);
    expect(Buffer.from(files[`objects/${objects.rawD}`] ?? [])).toEqual(bytesOf.rawD);
    expect(Buffer.from(files[`objects/${objects.fileD}`] ?? [])).toEqual(bytesOf.fileD);
    const manifest = JSON.parse(text("manifest.json")) as {
      counts: Record<string, number>;
      files: { path: string; bytes: number; sha256: string }[];
      missingObjects: string[];
    };
    expect(manifest.counts).toMatchObject({ missingObjects: 0 });
    for (const entry of manifest.files) {
      const data = files[entry.path] ?? new Uint8Array();
      expect(data.length, entry.path).toBe(entry.bytes);
      expect(createHash("sha256").update(data).digest("hex"), entry.path).toBe(entry.sha256);
    }
    // Another project is not in it, by row or by object.
    const everything = Object.entries(files)
      .map(([name, data]) => name + strFromU8(data))
      .join("\n");
    expect(everything).not.toContain(`Subject E ${run}`);
    expect(everything).not.toContain(projectE);
    expect(Object.keys(files).some((name) => name.includes(projectE))).toBe(false);
    // The settings are in it, and no secret is.
    expect(text("project.json")).toContain("smtp.example.test");
    expect(text("project.json")).toContain("hooks.example.test");
    expect(text("project.json")).toContain("We got your mail");
    expect(text("project.json")).toContain(`Group ${run}`);
    expect(text("project.json")).toContain(`${ids.plain}@example.test`);
    for (const secret of [
      secrets.connection,
      secrets.webhook,
      secrets.payload,
      agentToken,
      tokenHash(agentToken),
      "secretCiphertext",
      "tokenHash",
    ])
      expect(everything, secret).not.toContain(secret);
    // The file in the storage is the one that was described.
    const stored = await getObject(exportKey(projectD, made.id));
    expect(createHash("sha256").update(stored).digest("hex")).toBe(made.digest);
    expect(made.bytes).toBe(stored.length);
    expect((await listProjectExports(owner, projectD)).map((row) => row.id)).toContain(made.id);
    const [entry] = await db()
      .select()
      .from(audit)
      .where(
        and(
          eq(audit.projectId, projectD),
          eq(audit.action, "project.export"),
          eq(audit.targetId, made.id),
        ),
      );
    expect(entry?.detail).toMatchObject({ digest: made.digest });
  });
  async function exportOf(principal: Principal, ceiling?: number) {
    return createProjectExport(principal, projectD, ceiling);
  }
  it("is for the owner and for a person who manages the project, also when it is archived", async () => {
    expect(await outcome(createProjectExport(await asPerson(ids.plain), projectD))).toBe(
      "not_found",
    );
    expect(await outcome(createProjectExport(await asPerson(ids.other), projectD))).toBe(
      "not_found",
    );
    expect(await outcome(createProjectExport(await asAgent(), projectD))).toBe("forbidden");
    expect(await outcome(listProjectExports(await asPerson(ids.plain), projectD))).toBe(
      "not_found",
    );
    const made = await createProjectExport(await asPerson(ids.manager), projectD);
    await archiveProject(await asPerson(ids.manager), projectD);
    // The rights of an archived project are reduced; the membership decides.
    const manager = await asPerson(ids.manager);
    expect(await outcome(createProjectExport(manager, projectD))).toBe("ok");
    expect((await readProjectExport(manager, projectD, made.id)).digest).toBe(made.digest);
    expect(await outcome(readProjectExport(await asPerson(ids.other), projectD, made.id))).toBe(
      "not_found",
    );
    expect(await outcome(readProjectExport(manager, projectE, made.id))).toBe("not_found");
    expect(await outcome(readProjectExport(manager, projectD, randomUUID()))).toBe("not_found");
  });
  it("is refused above its ceiling, and says in the manifest which object the storage did not have", async () => {
    expect(await outcome(createProjectExport(ownerPrincipal, projectD, 10))).toBe(
      "project_export_too_large",
    );
    await db()
      .insert(ingress)
      .values({
        projectId: projectD,
        externalKey: `ext-missing-${run}`,
        rawObjectKey: `inbound/${projectD}/${"f".repeat(64)}.eml`,
        checksum: "z",
      });
    const made = await createProjectExport(ownerPrincipal, projectD);
    expect(made.counts.missingObjects).toBe(1);
    const file = await readProjectExport(ownerPrincipal, projectD, made.id);
    const manifest = JSON.parse(
      strFromU8(unzipSync(new Uint8Array(file.content))["manifest.json"] ?? new Uint8Array()),
    ) as {
      missingObjects: string[];
    };
    expect(manifest.missingObjects).toEqual([`inbound/${projectD}/${"f".repeat(64)}.eml`]);
    await db()
      .delete(ingress)
      .where(eq(ingress.externalKey, `ext-missing-${run}`));
  });
});
describe("the deletion of a project", () => {
  const give = (exportId: string, confirmName = `Delete D ${run}`) => ({ confirmName, exportId });
  it("is refused unless every condition holds", async () => {
    const owner = ownerPrincipal;
    const manager = await asPerson(ids.manager);
    const early = await createProjectExport(owner, projectD);
    // Not archived.
    expect(await outcome(deleteProject(owner, projectD, give(early.id)))).toBe("conflict");
    await archiveProject(manager, projectD);
    // Not the owner: a person who manages the project, a token, a person of another project.
    expect(
      await outcome(deleteProject(await asPerson(ids.manager), projectD, give(early.id))),
    ).toBe("forbidden");
    expect(await outcome(deleteProject(await asAgent(), projectD, give(early.id)))).toBe(
      "forbidden",
    );
    // An export that was made before the archive is not enough, and nor is none.
    expect(await outcome(deleteProject(owner, projectD, give(early.id)))).toBe("export_required");
    expect(await outcome(deleteProject(owner, projectD, give(randomUUID())))).toBe(
      "export_required",
    );
    const late = await createProjectExport(owner, projectD);
    // The name has to be typed as it is.
    for (const wrong of ["", "delete d", `Delete D ${run} `, "Delete E"])
      expect(await outcome(deleteProject(owner, projectD, give(late.id, wrong))), wrong).not.toBe(
        "ok",
      );
    expect(await outcome(deleteProject(owner, projectD, { exportId: late.id }))).not.toBe("ok");
    expect(await outcome(deleteProject(owner, projectD, { ...give(late.id), extra: 1 }))).not.toBe(
      "ok",
    );
    // The export of another project does not count.
    await archiveProject(await asPerson(ids.other), projectE).catch(() => undefined);
    // The file of the export has to be in the storage.
    await deleteObjects([exportKey(projectD, late.id)]);
    expect(await outcome(deleteProject(owner, projectD, give(late.id)))).toBe("export_required");
    // Nothing was deleted by any of this.
    const [row] = await db().select().from(projects).where(eq(projects.id, projectD));
    expect(row).toBeDefined();
    expect(await keysOf(`inbound/${projectD}/`)).toContain(objects.rawD);
  });
  it("removes the project with everything that belongs to it and nothing else, and keeps the audit and the export", async () => {
    await fill(projectD, `Subject D2 ${run}`, objects.rawD, objects.fileD);
    await fill(projectE, `Subject E2 ${run}`, objects.rawE, objects.fileE);
    const owner = ownerPrincipal;
    await archiveProject(await asPerson(ids.manager), projectD);
    const made = await createProjectExport(owner, projectD);
    const beforeE = await db()
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.projectId, projectE));
    const done = await deleteProject(owner, projectD, give(made.id));
    expect(done.deleted).toBe(true);
    expect(done.counts.tickets).toBeGreaterThan(0);
    expect(done.objects).toBeGreaterThan(0);
    // The rows are gone.
    expect(await db().select().from(projects).where(eq(projects.id, projectD))).toHaveLength(0);
    for (const table of [
      tickets,
      attachments,
      ingress,
      jobs,
      connections,
      webhooks,
      agents,
      memberships,
      operatorGroups,
      portalDomains,
      configChanges,
      projectTexts,
    ] as const)
      expect(
        await db()
          .select()
          .from(table)
          .where(eq((table as typeof tickets).projectId, projectD)),
        getTableName(table),
      ).toHaveLength(0);
    // The objects of the project are gone, those of the other project are not.
    expect(await keysOf(`inbound/${projectD}/`)).toEqual([]);
    expect(await keysOf(`attachments/${projectD}/`)).toEqual([]);
    expect(await keysOf(`inbound/${projectE}/`)).toContain(objects.rawE);
    expect(await keysOf(`attachments/${projectE}/`)).toContain(objects.fileE);
    expect(
      (await db().select({ id: tickets.id }).from(tickets).where(eq(tickets.projectId, projectE)))
        .length,
    ).toBe(beforeE.length);
    // The audit of the project stays as entries of the installation, and the deletion is written there.
    const kept = await db().select().from(audit).where(eq(audit.targetId, projectD));
    const deletion = kept.find((entry) => entry.action === "project.delete");
    expect(deletion?.projectId).toBeNull();
    expect(deletion?.actorId).toBe(ids.owner);
    expect(deletion?.detail).toMatchObject({
      name: `Delete D ${run}`,
      exportId: made.id,
      digest: made.digest,
    });
    expect(
      kept.some((entry) => entry.action === "project.archive" && entry.projectId === null),
    ).toBe(true);
    // The export outlives the project, and the owner can still read it.
    expect((await readProjectExport(owner, projectD, made.id)).digest).toBe(made.digest);
    expect(await outcome(deleteProject(owner, projectD, give(made.id)))).toBe("not_found");
    expect(await outcome(restoreProject(owner, projectD))).toBe("not_found");
  });
});
