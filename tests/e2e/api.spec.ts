import { z } from "zod";
import { expect, test } from "./fixtures";
// The router checks every response against its published schema outside
// production, so a 200 here means the definition describes what came back.
test("publishes the definition and answers its read routes in the published shape", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const { alpha } = desk.projects;
  const headers = { origin: baseURL ?? "" };
  // The definition needs no login.
  const open = await page.request.get("/api/v1/openapi.json");
  expect(open.status()).toBe(200);
  const document = (await open.json()) as { openapi: string; paths: Record<string, unknown> };
  expect(document.openapi).toBe("3.1.0");
  expect(Object.keys(document.paths)).toContain("/tickets/{ticketId}");
  expect((await page.request.get("/api/v1/projects")).status()).toBe(401);
  await signIn();
  const ticket = alpha.tickets[0];
  const reads = [
    "/projects",
    "/operators",
    "/tags",
    "/tickets",
    "/tickets?limit=5",
    "/tickets/search?q=request",
    `/tickets/${ticket}`,
    "/overview",
    "/junk",
    `/projects/${alpha.id}/agents`,
    `/projects/${alpha.id}/designs`,
    `/projects/${alpha.id}/config`,
    `/projects/${alpha.id}/config/changes`,
  ];
  for (const path of reads) {
    const response = await page.request.get(`/api/v1${path}`);
    expect(response.status(), `${path}: ${await response.text()}`).toBe(200);
  }
  // Writes answer in the published shape as well.
  for (const [path, data] of [
    [`/tickets/${ticket}/tags`, { tags: ["api-test"] }],
    [`/tickets/${ticket}/tags`, { tags: [] }],
    [`/tickets/${ticket}/reminder`, { remindAt: null }],
    [`/projects/${alpha.id}/designs/preview`, {}],
  ] as const) {
    const response = await page.request.post(`/api/v1${path}`, { data, headers });
    expect(response.status(), `${path}: ${await response.text()}`).toBe(200);
  }
  // Resolving and reopening, and assignment, answer in the published shape.
  const detail = z
    .object({ ticket: z.object({ revision: z.number() }) })
    .parse(await (await page.request.get(`/api/v1/tickets/${ticket}`)).json());
  const resolved = await page.request.post(`/api/v1/tickets/${ticket}/status`, {
    headers,
    data: { status: "resolved", expectedRevision: detail.ticket.revision },
  });
  expect(resolved.status(), await resolved.text()).toBe(200);
  const reopened = await page.request.post(`/api/v1/tickets/${ticket}/status`, {
    headers,
    data: { status: "open", expectedRevision: detail.ticket.revision + 1 },
  });
  expect(reopened.status(), await reopened.text()).toBe(200);
  const unassigned = await page.request.post(`/api/v1/tickets/${ticket}/assign`, {
    headers,
    data: { userId: null, agentId: null },
  });
  expect(unassigned.status(), await unassigned.text()).toBe(200);
  // An unknown path is not found, not a server error.
  expect((await page.request.get("/api/v1/nothing")).status()).toBe(404);
});
