import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { seal } from "../src/server/crypto";
import { env } from "../src/server/env";
import { initializeStorage } from "../src/server/storage";
import { processIngress, maxRawBytes } from "../src/server/inbound";
import {
  forwardedAddress,
  newPushToken,
  receivePush,
  sourceAllowed,
  type PushRequest,
} from "../src/server/inbound-push";
import { POST } from "../src/app/api/inbound/[connectionId]/route";
import { parseConnectionCreate } from "../src/domain/connections";
const projectId = randomUUID();
const address = `hello-${projectId.slice(0, 8)}@example.test`;
const token = newPushToken();
async function connection(
  config: Record<string, unknown> = {},
  options: { status?: string; secret?: string } = {},
) {
  const [created] = await db()
    .insert(connections)
    .values({
      projectId,
      kind: "push",
      name: "Push test",
      direction: "inbound",
      status: options.status ?? "ready",
      config: { addresses: [address], allowedSources: [], ...config },
      secretCiphertext: seal(
        JSON.stringify({ token: options.secret ?? token }),
        env().ENCRYPTION_KEY,
      ),
    })
    .returning({ id: connections.id });
  return created?.id ?? "";
}
function mail(subject: string, attachment = false): string {
  const head = [
    "From: Customer <customer@example.test>",
    `To: ${address}`,
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
function request(
  id: string,
  overrides: Partial<PushRequest> = {},
  body = mail("Hello"),
): PushRequest {
  return {
    connectionId: id,
    authorization: `Bearer ${token}`,
    recipient: address,
    deliveryId: randomUUID(),
    sourceAddress: "203.0.113.7",
    readBody: () => Promise.resolve(Buffer.from(body)),
    ...overrides,
  };
}
beforeAll(async () => {
  await migrate(db(), { migrationsFolder: "drizzle" });
  await initializeStorage();
  await db()
    .insert(projects)
    .values({ id: projectId, name: "Push test", slug: `push-${projectId}` });
});
afterAll(async () => {
  await db().delete(jobs).where(eq(jobs.projectId, projectId));
  await db().delete(attachments).where(eq(attachments.projectId, projectId));
  await db().delete(ingress).where(eq(ingress.projectId, projectId));
  await db().delete(tickets).where(eq(tickets.projectId, projectId));
  await db().delete(connections).where(eq(connections.projectId, projectId));
  await db().delete(projects).where(eq(projects.id, projectId));
  await sqlClient().end();
});
describe("source ranges", () => {
  it("allows everything for an empty list and only the listed ranges otherwise", () => {
    expect(sourceAllowed([], null)).toBe(true);
    expect(sourceAllowed(["203.0.113.0/24"], "203.0.113.7")).toBe(true);
    expect(sourceAllowed(["203.0.113.0/24"], "203.0.114.7")).toBe(false);
    expect(sourceAllowed(["203.0.113.0/24"], "::ffff:203.0.113.7")).toBe(true);
    expect(sourceAllowed(["2001:db8::/32"], "2001:db8::5")).toBe(true);
    expect(sourceAllowed(["2001:db8::/32"], "2001:db9::5")).toBe(false);
    expect(sourceAllowed(["203.0.113.0/24"], null)).toBe(false);
    expect(sourceAllowed(["203.0.113.0/24"], "not an address")).toBe(false);
  });
  it("takes the address that the nearest proxy saw", () => {
    expect(forwardedAddress("198.51.100.1, 203.0.113.7")).toBe("203.0.113.7");
    expect(forwardedAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(forwardedAddress(null)).toBeNull();
  });
});
describe("a connection of kind push", () => {
  it("is defined with addresses, ranges and a token that is long enough", () => {
    const base = {
      kind: "push",
      direction: "inbound",
      name: "Inbound",
      config: { addresses: [address] },
      secret: { token },
    };
    expect(parseConnectionCreate(base).kind).toBe("push");
    expect(() => parseConnectionCreate({ ...base, secret: { token: "short" } })).toThrow();
    expect(() => parseConnectionCreate({ ...base, config: { addresses: [] } })).toThrow();
    expect(() =>
      parseConnectionCreate({
        ...base,
        config: { addresses: [address], allowedSources: ["nowhere"] },
      }),
    ).toThrow();
  });
});
describe("the HTTPS endpoint", () => {
  it("accepts a message with an attachment once and answers a repeat as a duplicate", async () => {
    const id = await connection();
    const subject = `Push ${randomUUID()}`;
    const delivery = randomUUID();
    const first = await receivePush(request(id, { deliveryId: delivery }, mail(subject, true)));
    expect(first.status).toBe(202);
    expect(first.body.duplicate).toBe(false);
    const again = await receivePush(request(id, { deliveryId: delivery }, mail(subject, true)));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ingressId: first.body.ingressId, duplicate: true });
    const [entry] = await db()
      .select()
      .from(ingress)
      .where(eq(ingress.id, String(first.body.ingressId)));
    expect(entry?.externalKey).toBe(`delivery:${delivery}`);
    expect(entry?.origin).toEqual({ transport: "push", recipient: address });
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
  it("answers alike when the token is missing, wrong, or the connection is not ready or unknown", async () => {
    const ready = await connection();
    const draft = await connection({}, { status: "draft" });
    const disabled = await connection({}, { status: "disabled" });
    const refused = [
      await receivePush(request(ready, { authorization: null })),
      await receivePush(request(ready, { authorization: "Bearer wrong" })),
      await receivePush(request(ready, { authorization: token })),
      await receivePush(request(draft)),
      await receivePush(request(disabled)),
      await receivePush(request(randomUUID())),
      await receivePush(request("not-a-uuid")),
    ];
    for (const response of refused)
      expect(response).toEqual({ status: 401, body: { error: "unauthenticated" } });
  });
  it("does not read the body of a request that it refuses", async () => {
    const id = await connection();
    const readBody = vi.fn(() => Promise.resolve(Buffer.from("x")));
    await receivePush(request(id, { authorization: "Bearer wrong", readBody }));
    await receivePush(request(id, { recipient: "other@example.test", readBody }));
    await receivePush(request(id, { deliveryId: null, readBody }));
    expect(readBody).not.toHaveBeenCalled();
  });
  it("takes mail only for its addresses and only from its source ranges", async () => {
    const id = await connection({ allowedSources: ["203.0.113.0/24"] });
    expect((await receivePush(request(id, { recipient: "other@example.test" }))).status).toBe(422);
    expect((await receivePush(request(id, { recipient: address.toUpperCase() }))).status).toBe(202);
    expect((await receivePush(request(id, { sourceAddress: "198.51.100.9" }))).status).toBe(401);
    expect((await receivePush(request(id, { sourceAddress: null }))).status).toBe(401);
  });
  it("asks for a recipient and an id of the delivery", async () => {
    const id = await connection();
    expect((await receivePush(request(id, { recipient: null }))).status).toBe(400);
    expect((await receivePush(request(id, { deliveryId: null }))).status).toBe(400);
    expect((await receivePush(request(id, { deliveryId: "short" }))).status).toBe(400);
  });
  it("refuses a message that is too large or empty", async () => {
    const id = await connection();
    const tooLarge = () => Promise.reject(new Error("inbound_size"));
    expect((await receivePush(request(id, { readBody: tooLarge }))).status).toBe(413);
    const empty = () => Promise.resolve(Buffer.alloc(0));
    expect((await receivePush(request(id, { readBody: empty }))).status).toBe(413);
    const big = () => Promise.resolve(Buffer.alloc(maxRawBytes + 1, 97));
    expect((await receivePush(request(id, { readBody: big }))).status).toBe(413);
  });
  it("takes no mail for an archived project", async () => {
    const archived = randomUUID();
    await db()
      .insert(projects)
      .values({ id: archived, name: "Archived", slug: `push-${archived}`, archivedAt: new Date() });
    const [created] = await db()
      .insert(connections)
      .values({
        projectId: archived,
        kind: "push",
        name: "Push archived",
        direction: "inbound",
        status: "ready",
        config: { addresses: [address], allowedSources: [] },
        secretCiphertext: seal(JSON.stringify({ token }), env().ENCRYPTION_KEY),
      })
      .returning({ id: connections.id });
    expect((await receivePush(request(created?.id ?? ""))).status).toBe(409);
    await db().delete(connections).where(eq(connections.projectId, archived));
    await db().delete(projects).where(eq(projects.id, archived));
  });
  it("is served by the route with the headers of the contract", async () => {
    const id = await connection();
    const send = (headers: Record<string, string>, body = mail("Route")) =>
      POST(
        new Request(`http://localhost:3000/api/inbound/${id}`, {
          method: "POST",
          headers: { "content-type": "message/rfc822", ...headers },
          body,
        }),
        { params: Promise.resolve({ connectionId: id }) },
      );
    const good = {
      authorization: `Bearer ${token}`,
      "x-aidesk-recipient": address,
      "x-aidesk-delivery-id": randomUUID(),
    };
    expect((await send({})).status).toBe(401);
    const accepted = await send(good);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ duplicate: false });
    expect((await send(good)).status).toBe(200);
    const large = await send({
      ...good,
      "x-aidesk-delivery-id": randomUUID(),
      "content-length": String(maxRawBytes + 1),
    });
    expect(large.status).toBe(413);
  });
});
