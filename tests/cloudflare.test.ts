import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sqlClient } from "../src/server/db";
import { connections, ingress, jobs, projects, tickets } from "../src/server/db/schema";
import {
  inboundPrefix,
  parseCloudflareOutbound,
  pollCloudflareConnection,
  sendViaCloudflare,
} from "../src/server/cloudflare";
import { processIngress } from "../src/server/inbound";
import { initializeStorage, storage } from "../src/server/storage";
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
// The development object store stands in for R2: both speak the S3 API, and
// the Email Worker only writes objects under inbound/<recipient>/.
const projectId = randomUUID();
const bucket = `cf-${projectId.slice(0, 8)}`;
const address = `support-${projectId.slice(0, 8)}@example.test`;
async function connection(config: Record<string, unknown> = {}, secret = true) {
  const [created] = await db()
    .insert(connections)
    .values({
      projectId,
      kind: "cloudflare",
      name: "Test bucket",
      direction: "inbound",
      status: "ready",
      config: { endpoint: env().S3_ENDPOINT, bucket, address, developmentOnly: true, ...config },
      secretCiphertext: secret
        ? seal(
            JSON.stringify({
              accessKeyId: env().S3_ACCESS_KEY,
              secretAccessKey: env().S3_SECRET_KEY,
            }),
            env().ENCRYPTION_KEY,
          )
        : null,
    })
    .returning({ id: connections.id });
  return created?.id ?? "";
}
function mail(subject: string): string {
  return [
    "From: Customer <customer@example.test>",
    `To: ${address}`,
    `Subject: ${subject}`,
    `Message-ID: <${randomUUID()}@example.test>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Body of ${subject}`,
    "",
  ].join("\r\n");
}
async function put(key: string, body: string) {
  await storage().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}
async function keys(): Promise<string[]> {
  const listed = await storage().send(new ListObjectsV2Command({ Bucket: bucket }));
  return (listed.Contents ?? []).map((object) => object.Key ?? "");
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await storage().send(new CreateBucketCommand({ Bucket: bucket }));
  await db()
    .insert(projects)
    .values({ id: projectId, name: "Cloudflare test", slug: `cf-${projectId}` });
});
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEV_BOOTSTRAP", "true");
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  for (const key of await keys())
    await storage().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  await storage().send(new DeleteBucketCommand({ Bucket: bucket }));
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(ingress).where(eq(ingress.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(connections).where(eq(connections.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await sqlClient().end();
});
describe("Cloudflare inbound", () => {
  it("collects stored messages for its address once and removes them", async () => {
    const id = await connection();
    const prefix = inboundPrefix(address);
    const subject = `Cloudflare ${randomUUID()}`;
    await put(`${prefix}2026-10-12T10:00:00.000Z-a.eml`, mail(subject));
    await put(`${prefix}2026-10-12T10:00:01.000Z-b.eml`, mail("Second"));
    const foreign = "inbound/other@example.test/2026-10-12T10:00:00.000Z-c.eml";
    await put(foreign, mail("Not ours"));
    expect(await pollCloudflareConnection(id)).toEqual({ accepted: 2, duplicates: 0 });
    expect(await keys()).toEqual([foreign]);
    expect(await pollCloudflareConnection(id)).toEqual({ accepted: 0, duplicates: 0 });
    const entries = await db().select().from(ingress).where(eq(ingress.connectionId, id));
    expect(entries.map((entry) => entry.externalKey).sort()).toEqual([
      `cloudflare:${id}:${prefix}2026-10-12T10:00:00.000Z-a.eml`,
      `cloudflare:${id}:${prefix}2026-10-12T10:00:01.000Z-b.eml`,
    ]);
    const first = entries.find((entry) => entry.externalKey.endsWith("-a.eml"));
    expect(await processIngress(first?.id ?? "")).toBe("created");
    const [processed] = await db()
      .select()
      .from(ingress)
      .where(eq(ingress.id, first?.id ?? ""));
    const [ticket] = await db()
      .select()
      .from(tickets)
      .where(eq(tickets.id, processed?.ticketId ?? ""));
    expect(ticket?.subject).toBe(subject);
  });
  it("only removes an object that was left behind after it was accepted", async () => {
    const id = await connection();
    const key = `${inboundPrefix(address)}2026-10-12T11:00:00.000Z-left.eml`;
    await put(key, mail("Left behind"));
    expect(await pollCloudflareConnection(id)).toEqual({ accepted: 1, duplicates: 0 });
    // A crash between commit and delete leaves the same object in place.
    await put(key, mail("Left behind"));
    expect(await pollCloudflareConnection(id)).toEqual({ accepted: 0, duplicates: 1 });
    expect(await keys()).not.toContain(key);
    expect(await db().select().from(ingress).where(eq(ingress.connectionId, id))).toHaveLength(1);
  });
  it("refuses unsafe or unknown connections", async () => {
    const plain = await connection({ developmentOnly: false });
    await expect(pollCloudflareConnection(plain)).rejects.toThrow("cloudflare_tls_required");
    const development = await connection();
    vi.stubEnv("NODE_ENV", "production");
    await expect(pollCloudflareConnection(development)).rejects.toThrow(
      "development_connection_not_allowed",
    );
    await expect(pollCloudflareConnection(randomUUID())).rejects.toThrow(
      "cloudflare_connection_missing",
    );
    vi.stubEnv("NODE_ENV", "development");
    const unsecured = await connection({}, false);
    await expect(pollCloudflareConnection(unsecured)).rejects.toThrow("cloudflare_secret_missing");
    await db()
      .delete(connections)
      .where(inArray(connections.id, [plain, development, unsecured]));
  });
});
const accountId = "0123456789abcdef0123456789abcdef";
const outgoing = {
  fromName: "Orbit",
  to: "Customer@Example.test",
  subject: "Re: Export",
  html: "<p>Answer</p>",
  text: "Answer",
  inReplyTo: "<a@example.test>",
  references: "<a@example.test> <b@example.test>",
  ticketId: "ticket-1",
};
function reply(status: number, body: unknown) {
  const fetch = vi.fn(() => Promise.resolve(Response.json(body, { status })));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const send = () =>
  sendViaCloudflare(
    { accountId, from: "support@example.test", replyTo: "support@example.test" },
    { apiToken: "token-value" },
    outgoing,
  );
describe("Cloudflare outbound", () => {
  it("sends with threading headers and returns the assigned Message-ID", async () => {
    const fetch = reply(200, {
      success: true,
      errors: [],
      messages: [],
      result: {
        delivered: ["customer@example.test"],
        queued: [],
        permanent_bounces: [],
        message_id: "<assigned@example.test>",
      },
    });
    expect(await send()).toEqual({ messageId: "<assigned@example.test>" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`,
    );
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer token-value");
    expect(JSON.parse(init.body as string)).toEqual({
      from: { address: "support@example.test", name: "Orbit" },
      reply_to: "support@example.test",
      to: "Customer@Example.test",
      subject: "Re: Export",
      html: "<p>Answer</p>",
      text: "Answer",
      headers: {
        "X-Aidesk-Ticket": "ticket-1",
        "In-Reply-To": "<a@example.test>",
        References: "<a@example.test> <b@example.test>",
      },
    });
  });
  it("marks automatic mail and reads its sealed configuration", async () => {
    const withoutThread = Object.fromEntries(
      Object.entries(outgoing).filter(([key]) => key !== "inReplyTo"),
    ) as Omit<typeof outgoing, "inReplyTo">;
    const fetch = reply(200, {
      success: true,
      errors: [],
      messages: [],
      result: { delivered: ["customer@example.test"], queued: [], permanent_bounces: [] },
    });
    expect(
      await sendViaCloudflare(
        { accountId, from: "support@example.test", replyTo: "support@example.test" },
        { apiToken: "token-value" },
        { ...withoutThread, references: "not a message id", automatic: true },
      ),
    ).toEqual({ messageId: null });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(init.body as string) as { headers: unknown }).headers).toEqual({
      "X-Aidesk-Ticket": "ticket-1",
      "Auto-Submitted": "auto-replied",
      "X-Auto-Response-Suppress": "All",
    });
    const config = { accountId, from: "support@example.test", replyTo: "support@example.test" };
    expect(
      parseCloudflareOutbound(
        config,
        seal(JSON.stringify({ apiToken: "t" }), env().ENCRYPTION_KEY),
      ),
    ).toEqual({ config, secret: { apiToken: "t" } });
    expect(() => parseCloudflareOutbound(config, null)).toThrow("cloudflare_secret_missing");
  });
  it("tells a refusal apart from an unknown outcome", async () => {
    reply(403, {
      success: false,
      errors: [{ code: 10105, message: "email.sending.error.authentication.not_entitled" }],
      messages: [],
      result: null,
    });
    await expect(send()).rejects.toThrow("transport_rejected");
    reply(200, {
      success: true,
      errors: [],
      messages: [],
      result: { delivered: [], queued: [], permanent_bounces: ["customer@example.test"] },
    });
    await expect(send()).rejects.toThrow("transport_rejected");
    reply(500, { success: false, errors: [], messages: [], result: null });
    await expect(send()).rejects.toThrow("transport_acceptance_unknown");
    reply(200, {
      success: true,
      errors: [],
      messages: [],
      result: { delivered: ["someone-else@example.test"], queued: [], permanent_bounces: [] },
    });
    await expect(send()).rejects.toThrow("transport_acceptance_unknown");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network"))),
    );
    await expect(send()).rejects.toThrow("transport_acceptance_unknown");
  });
});
