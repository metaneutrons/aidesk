import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import { expect, test } from "./fixtures";
// Contract tests for the published API definition. The definition is read from
// the running application, exactly as a client reads it, and every answer is
// checked against it with a JSON Schema validator that has nothing to do with the
// zod schemas the server builds the definition from. A route that answers a shape
// its definition does not describe fails here, in CI, with real data behind it.
type Json = Record<string, unknown>;
const documentSchema = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.looseObject({ operationId: z.string() }))),
  components: z.looseObject({}),
});
type Document = z.infer<typeof documentSchema>;
const methods = ["get", "post", "put"];
// The validator takes the document as it is: references into `components` resolve
// against the schema's own root, so every schema is compiled with them attached.
function validator(document: Document) {
  const Ajv = (Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020;
  const ajv = new Ajv({ strict: false, allErrors: true });
  const formats = (addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats;
  formats(ajv);
  const components = document.components as Record<string, Record<string, Json>>;
  const operations = Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => methods.includes(method))
      .map(([method, operation]) => ({ path, method: method.toUpperCase(), operation })),
  );
  // The schema a status code of an operation promises, or null for a file.
  const schemaOf = (operation: Json, status: number): Json | null => {
    const responses = operation.responses as Record<string, Json>;
    let response = responses[String(status)];
    if (!response)
      throw new Error(`${String(operation.operationId)} does not document ${String(status)}`);
    const ref = response.$ref;
    if (typeof ref === "string")
      response = components.responses?.[ref.split("/").pop() ?? ""] ?? {};
    const content = response.content as Record<string, { schema: Json }> | undefined;
    const schema = content?.["application/json"]?.schema;
    return schema ? { ...schema, components } : null;
  };
  const check = (operation: Json, status: number, body: unknown, mutate?: (s: Json) => Json) => {
    const schema = schemaOf(operation, status);
    if (!schema) return [];
    const valid = ajv.compile(mutate ? mutate(schema) : schema);
    return valid(body)
      ? []
      : (valid.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ""}`);
  };
  return { operations, check };
}
const publishedDefinition = async (request: APIRequestContext) =>
  documentSchema.parse(await (await request.get("/api/v1/openapi.json")).json());
// What is not exercised with a success answer, and why. A route that is not here
// and not called below fails the test that counts them.
const notCalled: Record<string, string> = {
  "projects.create": "creates a project of the instance; the shape is checked by the invalid call",
  "operators.create":
    "creates an operator of the instance; the shape is checked by the invalid call",
  "operators.grant": "changes the rights of an operator; the shape is checked by the invalid call",
  "operators.active": "disables an operator; the shape is checked by the invalid call",
  "config.decide": "needs a pending proposal, which the sign-in of the fixture cannot make",
  "ai_profiles.set": "needs a connection to a model provider; covered by the profile tests",
  "tickets.assist_draft":
    "needs an AI task that is set up and a model provider; covered by the draft tests",
  "connections.test": "makes a request to the host of the connection",
  "designs.test": "sends a mail; covered by the designs test",
  "designs.test_status": "needs a queued test mail",
  "messages.original": "needs a stored original of a message",
  "messages.original_preview": "needs a stored original of a message",
  "messages.original_text": "needs a stored original of a message; covered by the attachments test",
  "attachments.get": "needs a stored attachment",
  "attachments.read": "needs a stored attachment; covered by the attachments test",
  "junk.get": "needs a mail in the junk folder",
  "junk.restore": "needs a mail in the junk folder",
  "tickets.junk": "moves a ticket of the fixture; covered by the desk test",
  "tickets.restore": "needs a ticket in the junk folder",
  "workspace.controls_set":
    "sets a switch of the whole installation, which would stop the agents or the mail of the tests that run beside; covered by the controls tests",
  "tickets.translate_draft":
    "needs an AI task that is set up and a model provider; covered by the translation tests",
  "texts.translate":
    "needs an AI task that is set up and a model provider; covered by the translation tests",
  "issues.link": "needs a repository of the project that answers; covered by the issue tests",
  "issues.unlink": "needs a linked issue; covered by the issue tests",
  "issues.draft_create": "needs a repository of the project; covered by the issue tests",
  "issues.draft_update": "needs a draft of an issue; covered by the issue tests",
  "issues.draft_discard": "needs a draft of an issue; covered by the issue tests",
  "issues.publish": "writes to a repository; covered by the issue tests",
  "issues.reconcile": "reads a repository for a publication; covered by the issue tests",
  "messages.send_draft": "needs a draft by an agent; covered by the drafts test",
  "messages.discard_draft": "needs a draft by an agent; covered by the drafts test",
};
test.describe.configure({ mode: "serial" });
test.skip(({ browserName }) => browserName !== "chromium", "Protocol test; runs once.");
test("answers every documented route in the published shape, with real data", async ({
  page,
  desk,
  signIn,
  baseURL,
}) => {
  const headers = { origin: baseURL ?? "" };
  const { operations, check } = validator(await publishedDefinition(page.request));
  await signIn();
  const project = desk.projects.alpha.id;
  const ticket = desk.projects.alpha.tickets[0];
  const covered = new Set<string>();
  // Calls a route by its operation id, checks status and body against the
  // definition and returns the body.
  async function call(
    id: string,
    options: {
      params?: Record<string, string>;
      query?: Record<string, string>;
      data?: unknown;
      status?: number[];
    } = {},
  ): Promise<Json> {
    const found = operations.filter((entry) => entry.operation.operationId === id);
    expect(found, `${id} is in the definition once`).toHaveLength(1);
    const { path, method, operation } = found[0] ?? { path: "", method: "", operation: {} };
    const url = path.replace(/\{(\w+)\}/g, (_, name: string) => options.params?.[name] ?? "");
    const response = await page.request.fetch(`/api/v1${url}`, {
      method,
      headers,
      params: options.query ?? {},
      ...(options.data === undefined ? {} : { data: options.data }),
    });
    const text = await response.text();
    expect(options.status ?? [200, 201, 202], `${id}: ${text}`).toContain(response.status());
    const body = (text ? JSON.parse(text) : {}) as Json;
    expect(check(operation, response.status(), body), `${id} answered ${text}`).toEqual([]);
    covered.add(id);
    return body;
  }
  // Reads.
  await call("projects.list");
  await call("operators.list");
  await call("tags.list");
  await call("tickets.list", { query: { limit: "5" } });
  await call("tickets.search", { query: { q: "request" } });
  await call("overview.get");
  await call("junk.list");
  await call("agents.list", { params: { projectId: project } });
  await call("designs.list", { params: { projectId: project } });
  // A connection to a model provider needs no host to be defined, so the routes of
  // connections are called with one; the list is read after it exists.
  const provider = await call("connections.create", {
    params: { projectId: project },
    data: {
      kind: "anthropic",
      direction: "ai",
      name: `Contract ${desk.run}`,
      config: {},
      secret: { apiKey: "contract-key-never-shown" },
    },
  });
  await call("connections.list", { params: { projectId: project } });
  const connectionParams = { projectId: project, connectionId: String(provider.connectionId) };
  const renamedConnection = await call("connections.update", {
    params: connectionParams,
    data: { expectedVersion: provider.version, name: `Contract changed ${desk.run}` },
  });
  await call("connections.disable", {
    params: connectionParams,
    data: { expectedVersion: renamedConnection.version },
  });
  await call("texts.list", { params: { projectId: project } });
  await call("ai_profiles.list", { params: { projectId: project } });
  await call("texts.versions", {
    params: { projectId: project, key: "acknowledgement", language: "en" },
  });
  await call("config.changes", { params: { projectId: project } });
  const config = await call("config.get", { params: { projectId: project } });
  const detail = await call("tickets.get", { params: { ticketId: ticket } });
  // Ticket work.
  await call("tickets.tags", { params: { ticketId: ticket }, data: { tags: ["contract"] } });
  await call("tickets.tags", { params: { ticketId: ticket }, data: { tags: [] } });
  await call("tickets.reminder", { params: { ticketId: ticket }, data: { remindAt: null } });
  await call("tickets.assign", {
    params: { ticketId: ticket },
    data: { userId: null, agentId: null },
  });
  await call("tickets.reply", {
    params: { ticketId: ticket },
    data: {
      markdown: `Contract note ${randomUUID()}`,
      internal: true,
      expectedRevision: (detail.ticket as { revision: number }).revision,
      idempotencyKey: randomUUID(),
      language: "en",
    },
  });
  const current = await call("tickets.get", { params: { ticketId: ticket } });
  const revision = (current.ticket as { revision: number }).revision;
  await call("tickets.status", {
    params: { ticketId: ticket },
    data: { status: "resolved", expectedRevision: revision },
  });
  await call("tickets.status", {
    params: { ticketId: ticket },
    data: { status: "open", expectedRevision: revision + 1 },
  });
  const link = await call("tickets.portal_link", { params: { ticketId: ticket }, data: {} });
  expect(link).toBeDefined();
  await call("tickets.portal_revoke", { params: { ticketId: ticket }, data: {} });
  // Configuration, with the dry run that writes nothing.
  await call("config.put", {
    params: { projectId: project },
    query: { validate: "true" },
    data: { config: config.config, expectedVersion: config.version },
  });
  await call("texts.set", {
    params: { projectId: project, key: "acknowledgement", language: "en" },
    query: { validate: "true" },
    data: { text: "We received #{number}.", expectedVersion: 0 },
  });
  await call("projects.settings", {
    params: { projectId: project },
    data: { acknowledgements: true },
  });
  // The project is shared with the specs of the run, which expect to find acknowledgements off.
  await call("projects.settings", {
    params: { projectId: project },
    data: { acknowledgements: false },
  });
  await call("operator.locale", { data: { locale: null } });
  // Designs, on a project that no other spec uses for designs: the designs spec counts the versions of
  // alpha and finds the one that this selects.
  const designProject = desk.projects.gamma.id;
  await call("designs.preview", { params: { projectId: designProject }, data: {} });
  const design = await call("designs.create", { params: { projectId: designProject }, data: {} });
  await call("designs.select", {
    params: { projectId: designProject },
    data: { version: design.version },
  });
  // Agents.
  const issued = await call("agents.issue", {
    params: { projectId: project },
    data: { name: `Contract ${desk.run}`, actions: ["project.read"] },
  });
  await call("agents.revoke", { params: { agentId: String(issued.id) } });
  // Webhooks.
  const hook = await call("webhooks.create", {
    params: { projectId: project },
    data: {
      name: `Contract ${desk.run}`,
      url: "http://localhost:3000/api/health/live",
      events: ["ticket.created"],
      secret: "contract-signing-secret",
      developmentOnly: true,
    },
  });
  // A proposal or a change names its object as `target` and gives the new version.
  const hookParams = { projectId: project, webhookId: String(hook.target) };
  await call("webhooks.list", { params: { projectId: project } });
  const renamed = await call("webhooks.update", {
    params: hookParams,
    data: { expectedVersion: hook.version, name: `Contract changed ${desk.run}` },
  });
  await call("webhooks.ping", { params: hookParams, data: {} });
  await call("webhooks.deliveries", { params: hookParams });
  await call("webhooks.disable", {
    params: hookParams,
    data: { expectedVersion: renamed.version },
  });
  // The sources of knowledge: the project has none in the fixture, which the answer says.
  await call("knowledge.search", { params: { ticketId: ticket }, query: { q: "printer" } });
  // Issues: the project has no repository in the fixture, which the answers say.
  await call("issues.list", { params: { ticketId: ticket } });
  await call("issues.search", { params: { ticketId: ticket }, query: { q: "printer" } });
  await call("issues.refresh", { params: { ticketId: ticket }, data: {} });
  // Translations of a message: asked for, listed (the worker answers that none can be made, as no
  // model is set up), removed; and a correction of the text, which gives it a new revision.
  const first = (detail.messages as { id: string; language: string; markdown: string }[])[0];
  const messageId = first?.id ?? "";
  await call("translations.request", {
    params: { messageId },
    data: { language: first?.language === "de" ? "en" : "de" },
  });
  await call("translations.list", { params: { messageId } });
  await call("translations.delete", { params: { messageId }, data: {} });
  await call("messages.correct", { params: { messageId }, data: { markdown: first?.markdown } });
  // Managed agents: assigned, listed with their runs, stopped and let go on a ticket and in the
  // project. The ticket is given back at the end.
  const managedAgent = await call("agents.create_managed", {
    params: { projectId: project },
    data: { name: `Contract managed ${desk.run}`, actions: ["ticket.read"] },
  });
  await call("tickets.assignees", { params: { ticketId: ticket } });
  await call("tickets.assign", {
    params: { ticketId: ticket },
    data: { userId: null, agentId: String(managedAgent.id) },
  });
  await call("tickets.agent_runs", { params: { ticketId: ticket } });
  // Stopped on the ticket and let go on again, which names the revision that was read; then
  // stopped and released for the project, and the switches of the workspace read.
  await call("tickets.stop_agent", { params: { ticketId: ticket }, data: {} });
  const stopped = await call("tickets.get", { params: { ticketId: ticket } });
  await call("tickets.resume_agent", {
    params: { ticketId: ticket },
    data: { expectedRevision: (stopped.ticket as { revision: number }).revision },
  });
  await call("projects.agent_controls", { params: { projectId: project } });
  await call("projects.agent_stop", { params: { projectId: project }, data: { stopped: true } });
  await call("projects.agent_stop", { params: { projectId: project }, data: { stopped: false } });
  await call("projects.resume_agents", { params: { projectId: project }, data: {} });
  await call("workspace.controls_get");
  await call("tickets.assign", {
    params: { ticketId: ticket },
    data: { userId: null, agentId: null },
  });
  await call("agents.revoke", { params: { agentId: String(managedAgent.id) } });
  // Every route is called above or has a reason here, and no reason is stale.
  const all = operations.map((entry) => entry.operation.operationId);
  const missing = all.filter((id) => !covered.has(id) && !(id in notCalled));
  expect(missing, "routes without a call and without a reason").toEqual([]);
  expect(Object.keys(notCalled).filter((id) => !all.includes(id))).toEqual([]);
  expect(Object.keys(notCalled).filter((id) => covered.has(id))).toEqual([]);
});
test("answers a call that is not valid, or not allowed, in the documented error shape", async ({
  page,
  request,
  desk,
  signIn,
  baseURL,
}) => {
  const headers = { origin: baseURL ?? "" };
  const { operations, check } = validator(await publishedDefinition(page.request));
  // Without a login every route is refused in the same shape.
  for (const { path, method, operation } of operations) {
    if (path === "/openapi.json") continue;
    const response = await request.fetch(`/api/v1${path.replace(/\{\w+\}/g, randomUUID())}`, {
      method,
      headers,
      data: method === "GET" ? undefined : {},
    });
    expect(response.status(), operation.operationId).toBe(401);
    expect(check(operation, 401, await response.json())).toEqual([]);
  }
  await signIn();
  // With a login, a call that names nothing that exists, and carries nothing, is
  // refused or answered empty, and the answer is one the route documents.
  for (const { path, method, operation } of operations) {
    const params: Record<string, string> = { key: "acknowledgement", language: "en" };
    const url = path.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? randomUUID());
    const response = await page.request.fetch(`/api/v1${url}`, {
      method,
      headers,
      ...(method === "GET" ? {} : { data: {} }),
    });
    const body = (await response.json()) as unknown;
    const id = operation.operationId;
    expect(check(operation, response.status(), body), `${id}: ${JSON.stringify(body)}`).toEqual([]);
  }
  expect(desk.run).toBeTruthy();
});
test("fails when an answer no longer has the shape the definition promises", async ({
  page,
  signIn,
  request,
}) => {
  const { operations, check } = validator(await publishedDefinition(request));
  await signIn();
  const operation = operations.find(
    (entry) => entry.operation.operationId === "overview.get",
  )?.operation;
  if (!operation) throw new Error("overview.get is not in the definition");
  const body = (await (await page.request.get("/api/v1/overview")).json()) as Json;
  // The real answer passes.
  expect(check(operation, 200, body)).toEqual([]);
  // A property the route stopped sending.
  expect(
    check(operation, 200, body, (schema) => ({
      ...schema,
      required: [...((schema.required as string[] | undefined) ?? []), "dropped"],
    })),
  ).not.toEqual([]);
  // A property that changed its type.
  expect(
    check(operation, 200, { ...body, projects: "none" }),
    "a changed type is found",
  ).not.toEqual([]);
  // A property the definition does not know.
  expect(check(operation, 200, { ...body, extra: true }), "an extra property is found").not.toEqual(
    [],
  );
  // A status the route does not document.
  expect(() => check(operation, 418, {})).toThrow("does not document 418");
});
