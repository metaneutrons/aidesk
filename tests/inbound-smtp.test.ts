import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import {
  attachments,
  connections,
  ingress,
  jobs,
  projects,
  tickets,
} from "../src/server/db/schema";
import { initializeStorage } from "../src/server/storage";
import { processIngress } from "../src/server/inbound";
import { startReceiver, type RunningReceiver } from "../src/server/inbound-smtp";
import { parseConnectionCreate } from "../src/domain/connections";
const projectId = randomUUID();
const otherProjectId = randomUUID();
const run = projectId.slice(0, 8);
const address = `hello-${run}@example.test`;
const second = `support-${run}@example.test`;
let receiver: RunningReceiver;
let secureReceiver: RunningReceiver;
let tiny: RunningReceiver;
let limited: RunningReceiver;
const certificates = mkdtempSync(join(tmpdir(), "aidesk-smtp-"));
async function connection(
  config: Record<string, unknown> = {},
  options: { status?: string; project?: string } = {},
) {
  const [created] = await db()
    .insert(connections)
    .values({
      projectId: options.project ?? projectId,
      kind: "smtp",
      name: "SMTP in test",
      direction: "inbound",
      status: options.status ?? "ready",
      config: { addresses: [address], allowedSources: [], requireTls: false, ...config },
    })
    .returning({ id: connections.id });
  return created?.id ?? "";
}
function message(subject: string, to: string, attachment = false): string {
  const head = [
    "From: Customer <customer@example.test>",
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@example.test>`,
    "MIME-Version: 1.0",
  ];
  if (!attachment)
    return [...head, "Content-Type: text/plain; charset=utf-8", "", `Body of ${subject}`, ""].join(
      "\r\n",
    );
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Body of ${subject}`,
    "--b1",
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("notes of the customer").toString("base64"),
    "--b1--",
    "",
  ].join("\r\n");
}
// Sends through the receiver and returns the error code of the refusal, or null when it was taken.
async function send(
  on: RunningReceiver,
  to: string | string[],
  raw: string,
  tls = false,
): Promise<number | null> {
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: on.port,
    secure: false,
    ignoreTLS: !tls,
    requireTLS: tls,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10_000,
  });
  try {
    await transport.sendMail({ envelope: { from: "customer@example.test", to }, raw });
    return null;
  } catch (error) {
    return (error as { responseCode?: number }).responseCode ?? -1;
  } finally {
    transport.close();
  }
}
async function count(project: string): Promise<number> {
  return (await db().select().from(ingress).where(eq(ingress.projectId, project))).length;
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  for (const id of [projectId, otherProjectId])
    await db()
      .insert(projects)
      .values({ id, name: "SMTP in test", slug: `smtp-in-${id}` });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(certificates, "key.pem"),
      "-out",
      join(certificates, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  receiver = await startReceiver({ port: 0, host: "127.0.0.1" });
  secureReceiver = await startReceiver({
    port: 0,
    host: "127.0.0.1",
    tlsKeyFile: join(certificates, "key.pem"),
    tlsCertFile: join(certificates, "cert.pem"),
  });
  tiny = await startReceiver({ port: 0, host: "127.0.0.1", maxMessageBytes: 2000 });
  limited = await startReceiver({ port: 0, host: "127.0.0.1", maxClientsPerAddress: 1 });
});
afterAll(async () => {
  for (const running of [receiver, secureReceiver, tiny, limited]) await running.close();
  for (const id of [projectId, otherProjectId]) {
    await db().delete(jobs).where(eq(jobs.projectId, id));
    await db().delete(attachments).where(eq(attachments.projectId, id));
    await db().delete(ingress).where(eq(ingress.projectId, id));
    await db().delete(tickets).where(eq(tickets.projectId, id));
    await db().delete(connections).where(eq(connections.projectId, id));
    await db().delete(projects).where(eq(projects.id, id));
  }
  rmSync(certificates, { recursive: true, force: true });
  await sqlClient().end();
});
describe("an inbound connection of kind smtp", () => {
  it("is defined with addresses, ranges and an option for TLS, and has no secret", () => {
    const base = {
      kind: "smtp",
      direction: "inbound",
      name: "Inbound",
      config: { addresses: [address] },
    };
    const parsed = parseConnectionCreate(base);
    expect(parsed.kind).toBe("smtp");
    expect(parsed.config).toMatchObject({ allowedSources: [], requireTls: false });
    expect(() => parseConnectionCreate({ ...base, config: { addresses: [] } })).toThrow();
    expect(() => parseConnectionCreate({ ...base, secret: { pass: "x" } })).toThrow();
  });
});
describe("the SMTP receiver", () => {
  it("takes a message with an attachment for a configured address, once", async () => {
    await connection();
    const subject = `Mail ${randomUUID()}`;
    const raw = message(subject, address, true);
    expect(await send(receiver, address.toUpperCase(), raw)).toBeNull();
    expect(await send(receiver, address, raw)).toBeNull();
    const entries = await db().select().from(ingress).where(eq(ingress.projectId, projectId));
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.externalKey).toMatch(/^smtp:[0-9a-f]{64}$/);
    expect(entry?.origin).toEqual({
      transport: "smtp",
      envelopeFrom: "customer@example.test",
      recipients: [address.toLowerCase()],
    });
    expect(await processIngress(entry?.id ?? "")).toBe("created");
    const [processed] = await db()
      .select()
      .from(ingress)
      .where(eq(ingress.id, entry?.id ?? ""));
    const [ticket] = await db()
      .select()
      .from(tickets)
      .where(eq(tickets.id, processed?.ticketId ?? ""));
    expect(ticket?.subject).toBe(subject);
    const files = await db().select().from(attachments).where(eq(attachments.projectId, projectId));
    expect(files.map((file) => file.filename)).toContain("notes.txt");
  });
  it("refuses an address that no connection that is ready names, and takes nothing for it", async () => {
    const before = await count(projectId);
    expect(await send(receiver, `nobody-${run}@example.test`, message("x", address))).toBe(550);
    const draft = `draft-${run}@example.test`;
    await connection({ addresses: [draft] }, { status: "draft" });
    expect(await send(receiver, draft, message("x", draft))).toBe(550);
    const disabled = `disabled-${run}@example.test`;
    await connection({ addresses: [disabled] }, { status: "disabled" });
    expect(await send(receiver, disabled, message("x", disabled))).toBe(550);
    expect(await count(projectId)).toBe(before);
  });
  it("takes a message for two addresses of one project once", async () => {
    await connection({ addresses: [second] });
    const before = await count(projectId);
    expect(
      await send(receiver, [address, second], message(`Both ${randomUUID()}`, address)),
    ).toBeNull();
    expect(await count(projectId)).toBe(before + 1);
  });
  it("takes a message for addresses of two projects once for each", async () => {
    const other = `other-${run}@example.test`;
    await connection({ addresses: [other] }, { project: otherProjectId });
    const before = [await count(projectId), await count(otherProjectId)];
    expect(
      await send(receiver, [address, other], message(`Two ${randomUUID()}`, address)),
    ).toBeNull();
    expect([await count(projectId), await count(otherProjectId)]).toEqual([
      before[0] === undefined ? 0 : before[0] + 1,
      before[1] === undefined ? 0 : before[1] + 1,
    ]);
  });
  it("answers alike for an unknown address and for a source that is not allowed", async () => {
    const narrow = `narrow-${run}@example.test`;
    await connection({ addresses: [narrow], allowedSources: ["203.0.113.0/24"] });
    expect(await send(receiver, narrow, message("x", narrow))).toBe(550);
    const near = `near-${run}@example.test`;
    await connection({ addresses: [near], allowedSources: ["127.0.0.0/8"] });
    expect(await send(receiver, near, message(`Near ${randomUUID()}`, near))).toBeNull();
  });
  it("asks for STARTTLS where the connection requires it, and takes the message after it", async () => {
    const secure = `secure-${run}@example.test`;
    await connection({ addresses: [secure], requireTls: true });
    // A receiver without a certificate does not offer STARTTLS, so the sender cannot satisfy the connection.
    expect(await send(receiver, secure, message("x", secure))).toBe(530);
    expect(
      await send(secureReceiver, secure, message(`Secure ${randomUUID()}`, secure), true),
    ).toBeNull();
  });
  it("refuses a message over the limit, and the next one on the same receiver is taken", async () => {
    const before = await count(projectId);
    const big = `${message("Big", address)}${"x".repeat(5000)}\r\n`;
    expect(await send(tiny, address, big)).toBe(552);
    expect(await count(projectId)).toBe(before);
    expect(await send(tiny, address, message(`Small ${randomUUID()}`, address))).toBeNull();
    expect(await count(projectId)).toBe(before + 1);
  });
  it("answers 450 for an archived project, so that the sender tries again", async () => {
    const archived = randomUUID();
    await db()
      .insert(projects)
      .values({
        id: archived,
        name: "Archived",
        slug: `smtp-in-${archived}`,
        archivedAt: new Date(),
      });
    const closed = `closed-${run}@example.test`;
    await connection({ addresses: [closed] }, { project: archived });
    expect(await send(receiver, closed, message("x", closed))).toBe(450);
    await db().delete(connections).where(eq(connections.projectId, archived));
    await db().delete(projects).where(eq(projects.id, archived));
  });
  it("does not offer a login and limits the connections of one address", async () => {
    const dialogue = (on: RunningReceiver) =>
      new Promise<string>((resolve) => {
        const socket = createConnection(on.port, "127.0.0.1");
        let text = "";
        let spoke = false;
        socket.on("data", (chunk) => {
          text += chunk.toString();
          // The receiver refuses a client that talks before the greeting, so wait for it.
          if (!spoke && text.startsWith("220")) {
            spoke = true;
            socket.write("EHLO test.example\r\n");
          } else if (spoke && text.includes("\r\n250 ")) socket.write("QUIT\r\n");
        });
        socket.on("close", () => {
          resolve(text);
        });
        setTimeout(() => {
          socket.destroy();
        }, 1500).unref();
      });
    const greeting = await dialogue(receiver);
    expect(greeting).toContain("250");
    expect(greeting).not.toMatch(/AUTH/i);
    expect(greeting).not.toMatch(/STARTTLS/i);
    expect(await dialogue(secureReceiver)).toMatch(/STARTTLS/i);
    const first = createConnection(limited.port, "127.0.0.1");
    await new Promise((resolve) => first.once("data", resolve));
    const refused = await new Promise<string>((resolve) => {
      const next = createConnection(limited.port, "127.0.0.1");
      next.once("data", (chunk) => {
        resolve(chunk.toString());
        next.destroy();
      });
    });
    first.destroy();
    expect(refused).toMatch(/^421 /);
  });
});
