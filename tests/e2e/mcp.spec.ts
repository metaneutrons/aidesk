import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { expect, test } from "./fixtures";
// MCP over real HTTPS through the development proxy, with certificate
// verification against the proxy's local root CA only.
const endpoint = new URL(process.env.E2E_MCP_URL ?? "https://localhost:8443/api/mcp");
const ca = execFileSync("sh", ["scripts/dev.sh", "https-ca"], { encoding: "utf8" });
const verifiedFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const outgoing = httpsRequest(
      url,
      { method: init?.method ?? "GET", headers: Object.fromEntries(headers), ca },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers))
            if (typeof value === "string") responseHeaders.set(name, value);
          resolve(
            new Response(incoming.statusCode === 204 ? null : Buffer.concat(chunks), {
              status: incoming.statusCode ?? 500,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    outgoing.on("error", reject);
    if (typeof init?.body === "string") outgoing.write(init.body);
    outgoing.end();
  });
async function connect(token: string, fetch = verifiedFetch) {
  const client = new Client({ name: "aidesk-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  // The SDK declares sessionId as `string | undefined` on the class but as an
  // optional string on its Transport interface, which exactOptionalPropertyTypes
  // rejects. The runtime contract is the same.
  await client.connect(transport as Transport);
  return client;
}
const textResult = z.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) });
test.describe.configure({ mode: "serial" });
test.skip(({ browserName }) => browserName !== "chromium", "Protocol test; runs once.");
test("serves a project-scoped token over HTTPS and stops after revocation", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  await signIn();
  const issued = await page.request.post(`/api/v1/projects/${desk.projects.alpha.id}/agents`, {
    data: { name: "E2E MCP client", actions: ["project.read", "ticket.read", "ticket.note"] },
    headers: { origin: baseURL ?? "" },
  });
  expect(issued.status()).toBe(201);
  const { id, token } = z.object({ id: z.uuid(), token: z.string() }).parse(await issued.json());
  const client = await connect(token);
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  // The hand-written tools and the ones the route table offers for these actions.
  expect(tools).toEqual([
    "attachments_read",
    "messages_read_original",
    "overview_get",
    "projects_list",
    "tags_list",
    "tickets_get",
    "tickets_list",
    "tickets_reply",
    "tickets_search",
    "tickets_set_tags",
  ]);
  const projects = z
    .array(z.object({ id: z.string() }))
    .parse(
      JSON.parse(
        textResult.parse(await client.callTool({ name: "projects_list" })).content[0]?.text ?? "",
      ),
    );
  expect(projects.map((project) => project.id)).toEqual([desk.projects.alpha.id]);
  const hidden = await client.callTool({
    name: "tickets_get",
    arguments: { ticketId: desk.projects.beta.tickets[0] },
  });
  expect(hidden.isError).toBe(true);
  const ticket = desk.projects.alpha.tickets[0];
  const detail = z
    .object({ ticket: z.object({ revision: z.number(), language: z.string() }) })
    .parse(
      JSON.parse(
        textResult.parse(
          await client.callTool({ name: "tickets_get", arguments: { ticketId: ticket } }),
        ).content[0]?.text ?? "",
      ),
    );
  const base = {
    ticketId: ticket,
    markdown: `MCP note ${randomUUID()}`,
    expectedRevision: detail.ticket.revision,
    language: detail.ticket.language,
  };
  const publicReply = await client.callTool({
    name: "tickets_reply",
    arguments: { ...base, internal: false, idempotencyKey: randomUUID() },
  });
  expect(publicReply.isError).toBe(true);
  const note = await client.callTool({
    name: "tickets_reply",
    arguments: { ...base, internal: true, idempotencyKey: randomUUID() },
  });
  expect(note.isError).toBeFalsy();
  // A tool of the route table acts through the same operation as REST.
  const tagged = await client.callTool({
    name: "tickets_set_tags",
    arguments: { ticketId: ticket, tags: ["from-mcp"] },
  });
  expect(tagged.isError).toBeFalsy();
  expect(JSON.parse(textResult.parse(tagged).content[0]?.text ?? "")).toEqual({
    tags: ["from-mcp"],
  });
  const overview = textResult.parse(await client.callTool({ name: "overview_get", arguments: {} }));
  expect(JSON.parse(overview.content[0]?.text ?? "")).toHaveProperty("projects");
  // A project outside the token's grant is refused with the same error as REST.
  const foreign = await client.callTool({
    name: "tickets_set_tags",
    arguments: { ticketId: desk.projects.beta.tickets[0], tags: ["no"] },
  });
  expect(foreign.isError).toBe(true);
  await page.request.post(`/api/v1/tickets/${ticket}/tags`, {
    headers: { origin: baseURL ?? "" },
    data: { tags: [] },
  });
  await client.close();
  const revoked = await page.request.post(`/api/v1/agents/${id}/revoke`, {
    headers: { origin: baseURL ?? "" },
  });
  expect(revoked.ok()).toBe(true);
  await expect(connect(token)).rejects.toThrow();
});
test("refuses missing credentials and unverified TLS", async () => {
  await expect(connect("aidesk_not-a-valid-token")).rejects.toThrow();
  // Without the proxy's root CA the TLS handshake must fail.
  const response = await fetch(endpoint, { method: "POST" }).catch((error: unknown) => error);
  expect(response).toBeInstanceOf(Error);
});
