import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import worker, { type Env } from "../cloudflare/mail-ingest/index";
import { POST } from "../src/app/api/inbound/[connectionId]/route";
import { externalKeyOf, pollCloudflareConnection } from "../src/server/cloudflare";
import { seal } from "../src/server/crypto";
import { db, sqlClient } from "../src/server/db";
import { connections, ingress, jobs, projects } from "../src/server/db/schema";
import { env as serverEnv } from "../src/server/env";
import { newPushToken } from "../src/server/inbound-push";
import { initializeStorage, storage } from "../src/server/storage";
// The Email Worker against the real endpoint of the product: the VPC binding of the worker is the route handler, and
// the bucket of the fallback is the development object store, which speaks the S3 API like R2.
const projectId = randomUUID();
const bucket = `mw-${projectId.slice(0, 8)}`;
const address = `hello-${projectId.slice(0, 8)}@example.test`;
const token = newPushToken();
let pushId = "";
let pollId = "";
const stored: { key: string; metadata: Record<string, string> }[] = [];
const message = (to = address, forward = vi.fn(() => Promise.resolve())) => ({
  from: "customer@example.test",
  to,
  raw: new Response(
    [
      "From: Customer <customer@example.test>",
      `To: ${to}`,
      "Subject: Worker test",
      `Message-ID: <${randomUUID()}@example.test>`,
      "",
      "Body",
      "",
    ].join("\r\n"),
  ).body as ReadableStream<Uint8Array>,
  forward,
});
// The bucket of the worker: what it puts is written to the object store, with its metadata.
const mailBucket = {
  put: async (
    key: string,
    value: ArrayBuffer,
    options: { customMetadata: Record<string, string> },
  ) => {
    stored.push({ key, metadata: options.customMetadata });
    await storage().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from(value),
        Metadata: options.customMetadata,
      }),
    );
  },
};
// The tunnel of the product: the call goes to the route handler of the endpoint.
const through = (answer?: (response: Response) => Promise<Response>) => ({
  fetch: async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const response = await POST(new Request(`http://localhost:3000${path}`, init), {
      params: Promise.resolve({ connectionId: path.split("/").at(-1) ?? "" }),
    });
    return answer ? answer(response) : response;
  },
});
const routes = () => JSON.stringify({ [address]: { connection: pushId, token } });
async function ingressCount(): Promise<number> {
  return (await db().select().from(ingress).where(eq(ingress.projectId, projectId))).length;
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
    .values({ id: projectId, name: "Worker test", slug: `mw-${projectId}` });
  const [push] = await db()
    .insert(connections)
    .values({
      projectId,
      kind: "push",
      name: "Push",
      direction: "inbound",
      status: "ready",
      config: { addresses: [address], allowedSources: [] },
      secretCiphertext: seal(JSON.stringify({ token }), serverEnv().ENCRYPTION_KEY),
    })
    .returning({ id: connections.id });
  pushId = push?.id ?? "";
  const [poll] = await db()
    .insert(connections)
    .values({
      projectId,
      kind: "cloudflare",
      name: "Bucket",
      direction: "inbound",
      status: "ready",
      config: {
        endpoint: serverEnv().S3_ENDPOINT,
        bucket,
        address,
        developmentOnly: true,
      },
      secretCiphertext: seal(
        JSON.stringify({
          accessKeyId: serverEnv().S3_ACCESS_KEY,
          secretAccessKey: serverEnv().S3_SECRET_KEY,
        }),
        serverEnv().ENCRYPTION_KEY,
      ),
    })
    .returning({ id: connections.id });
  pollId = poll?.id ?? "";
});
beforeEach(() => {
  stored.length = 0;
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DEV_BOOTSTRAP", "true");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  for (const key of await keys())
    await storage().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  await storage().send(new DeleteBucketCommand({ Bucket: bucket }));
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(ingress).where(eq(ingress.projectId, projectId));
  await db().delete(connections).where(eq(connections.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await sqlClient().end();
});
describe("the key of a message in the bucket", () => {
  it("is the delivery id when the object has one, and the object key otherwise", () => {
    expect(externalKeyOf("c1", "inbound/a/1.eml", "0b0c9c3e-1111-4a0e-9d57-6a2f1b3c0d11")).toBe(
      "delivery:0b0c9c3e-1111-4a0e-9d57-6a2f1b3c0d11",
    );
    expect(externalKeyOf("c1", "inbound/a/1.eml", undefined)).toBe("cloudflare:c1:inbound/a/1.eml");
    expect(externalKeyOf("c1", "inbound/a/1.eml", "no good!")).toBe(
      "cloudflare:c1:inbound/a/1.eml",
    );
  });
});
describe("the Email Worker", () => {
  it("hands a message over through the endpoint and leaves nothing in the bucket", async () => {
    const before = await ingressCount();
    const forward = vi.fn(() => Promise.resolve());
    await worker.email(message(address.toUpperCase(), forward), {
      AIDESK: through(),
      AIDESK_ROUTES: routes(),
      MAIL: mailBucket,
      COPY_TO: "copy@example.test",
    } satisfies Env);
    expect(await ingressCount()).toBe(before + 1);
    expect(stored).toEqual([]);
    expect(forward).toHaveBeenCalledWith("copy@example.test");
  });
  it("uses the bucket when the endpoint refuses or does not answer, and a failed copy is not a failure", async () => {
    const before = await ingressCount();
    const refused = through(() => Promise.resolve(new Response(null, { status: 503 })));
    const lost = { fetch: () => Promise.reject(new Error("no route")) };
    const wrong = { ...(JSON.parse(routes()) as Record<string, object>) };
    wrong[address] = { connection: pushId, token: "x".repeat(64) };
    for (const target of [refused, lost, through()]) {
      const forward = vi.fn(() => Promise.reject(new Error("not verified")));
      await worker.email(message(address, forward), {
        AIDESK: target,
        AIDESK_ROUTES: target === lost ? routes() : JSON.stringify(wrong),
        MAIL: mailBucket,
        COPY_TO: "copy@example.test",
      });
      expect(forward).toHaveBeenCalled();
    }
    expect(stored).toHaveLength(3);
    for (const entry of stored) {
      expect(entry.key).toMatch(new RegExp(`^inbound/${address}/`));
      expect(entry.metadata.delivery).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(await ingressCount()).toBe(before);
    for (const key of await keys())
      await storage().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  });
  it("uses the bucket for an address without a route or without a way to reach aidesk", async () => {
    await worker.email(message("other@example.test"), {
      AIDESK: through(),
      AIDESK_ROUTES: routes(),
      MAIL: mailBucket,
    });
    await worker.email(message(), { AIDESK_ROUTES: routes(), MAIL: mailBucket });
    await worker.email(message(), {
      AIDESK: through(),
      AIDESK_ROUTES: "not json",
      MAIL: mailBucket,
    });
    expect(stored).toHaveLength(3);
    for (const key of await keys())
      await storage().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  });
  it("fails when neither way works, so that Email Routing does not count the message as delivered", async () => {
    const refused = through(() => Promise.resolve(new Response(null, { status: 503 })));
    await expect(
      worker.email(message(), { AIDESK: refused, AIDESK_ROUTES: routes() }),
    ).rejects.toThrow("not_delivered");
    await expect(worker.email(message(), {})).rejects.toThrow("not_delivered");
  });
  it("takes a message once that was taken by the endpoint and then also left in the bucket", async () => {
    // The endpoint takes the message, and its answer is lost on the way back.
    const lostAnswer = through(() => Promise.reject(new Error("connection reset")));
    const before = await ingressCount();
    await worker.email(message(), {
      AIDESK: lostAnswer,
      AIDESK_ROUTES: routes(),
      MAIL: mailBucket,
    });
    expect(await ingressCount()).toBe(before + 1);
    expect(stored).toHaveLength(1);
    // The poller finds the object, knows its delivery id, removes it and makes nothing new.
    expect(await pollCloudflareConnection(pollId)).toEqual({ accepted: 0, duplicates: 1 });
    expect(await ingressCount()).toBe(before + 1);
    expect(await keys()).toEqual([]);
  });
});
