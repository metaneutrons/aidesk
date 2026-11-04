import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  cannedInput,
  cannedRemoval,
  maxCannedReplies,
  renderCanned,
  type CannedLanguage,
} from "../domain/canned";
import type { ConfigDiffEntry } from "../domain/configuration";
import { permits, type Principal } from "../domain/permissions";
import { submitChange, type ChangeOutcome, type Tx } from "./changes";
import { db } from "./db";
import { agents, audit, cannedReplies, user } from "./db/schema";
import { DomainError } from "./errors";
import { getTicket } from "./operations";
// The canned replies of a project (see `domain/canned.ts`). A person with `config.write` adds, changes and removes
// them; an agent does the same as a proposal under the review policy, which a person with `config.approve` decides.
// Who may reply to a ticket reads them, filled in for that ticket.
const id = z.uuid();
const languageOf = (value: string): CannedLanguage => (value === "de" ? "de" : "en");
const view = (row: typeof cannedReplies.$inferSelect) => ({
  id: row.id,
  name: row.name,
  language: languageOf(row.language),
  body: row.body,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});
export async function listCannedReplies(principal: Principal, projectId: string) {
  const project = id.parse(projectId);
  if (!permits(principal, project, "config.read") && !permits(principal, project, "ticket.reply"))
    throw new DomainError("not_found", 404);
  const rows = await db()
    .select()
    .from(cannedReplies)
    .where(eq(cannedReplies.projectId, project))
    .orderBy(asc(cannedReplies.language), asc(cannedReplies.name));
  return rows.map(view);
}
// The replies that can be used for a ticket, with the placeholders filled in: the replies in the language of the
// ticket first, then the others. The name that fills `operator_name` is that of the person or the agent who asks.
export async function cannedForTicket(principal: Principal, ticketId: string) {
  const { ticket } = await getTicket(principal, ticketId);
  if (!permits(principal, ticket.projectId, "ticket.reply"))
    throw new DomainError("forbidden", 403);
  const rows = await db()
    .select()
    .from(cannedReplies)
    .where(eq(cannedReplies.projectId, ticket.projectId))
    .orderBy(asc(cannedReplies.name));
  const [who] =
    principal.kind === "human"
      ? await db().select({ name: user.name }).from(user).where(eq(user.id, principal.id))
      : await db().select({ name: agents.name }).from(agents).where(eq(agents.id, principal.id));
  const values = {
    customer_name: ticket.requesterName,
    ticket_number: String(ticket.number),
    operator_name: who?.name ?? "",
  };
  return [...rows]
    .sort(
      (a, b) =>
        Number(b.language === ticket.language) - Number(a.language === ticket.language) ||
        a.language.localeCompare(b.language) ||
        a.name.localeCompare(b.name),
    )
    .map((row) => ({
      id: row.id,
      name: row.name,
      language: languageOf(row.language),
      text: renderCanned(row.body, values),
    }));
}
function writable(principal: Principal, projectId: string): string {
  const project = id.parse(projectId);
  if (!permits(principal, project, "config.read") && !permits(principal, project, "config.write"))
    throw new DomainError("not_found", 404);
  if (!permits(principal, project, "config.write")) throw new DomainError("forbidden", 403);
  return project;
}
const sameName = (tx: Pick<Tx, "select">, project: string, language: string, name: string) =>
  tx
    .select({ id: cannedReplies.id })
    .from(cannedReplies)
    .where(
      and(
        eq(cannedReplies.projectId, project),
        eq(cannedReplies.language, language),
        sql`lower(${cannedReplies.name}) = lower(${name})`,
      ),
    );
export async function createCannedReply(
  principal: Principal,
  projectId: string,
  input: unknown,
  options: { validate?: boolean } = {},
): Promise<ChangeOutcome> {
  const project = writable(principal, projectId);
  const request = cannedInput.parse(input);
  return submitChange(
    principal,
    project,
    {
      kind: "canned.create",
      idempotencyKey: request.idempotencyKey,
      prepare: async (tx) => {
        const rows = await tx
          .select({ id: cannedReplies.id })
          .from(cannedReplies)
          .where(eq(cannedReplies.projectId, project));
        if (rows.length >= maxCannedReplies) throw new DomainError("invalid_input", 400);
        if ((await sameName(tx, project, request.language, request.name)).length > 0)
          throw new DomainError("conflict", 409);
        return {
          target: null,
          version: null,
          payload: { name: request.name, language: request.language, body: request.body },
          diff: [
            {
              pointer: `/canned/${request.language}/${request.name}`,
              from: null,
              to: request.body,
            },
          ],
        };
      },
      apply: (tx, change) =>
        applyCannedPayload(
          tx,
          project,
          "canned.create",
          change.target,
          change.payload,
          principal.id,
          change.diff,
        ),
    },
    options,
  );
}
export async function updateCannedReply(
  principal: Principal,
  projectId: string,
  replyId: string,
  input: unknown,
  options: { validate?: boolean } = {},
): Promise<ChangeOutcome> {
  const project = writable(principal, projectId);
  const target = id.parse(replyId);
  const request = cannedInput.parse(input);
  if (request.expectedVersion === undefined)
    throw new z.ZodError([
      { code: "custom", path: ["expectedVersion"], message: "Name the version that was read" },
    ]);
  const expected = request.expectedVersion;
  return submitChange(
    principal,
    project,
    {
      kind: "canned.update",
      idempotencyKey: request.idempotencyKey,
      prepare: async (tx) => {
        const [current] = await tx
          .select()
          .from(cannedReplies)
          .where(and(eq(cannedReplies.id, target), eq(cannedReplies.projectId, project)));
        if (!current) throw new DomainError("not_found", 404);
        if (current.version !== expected) throw new DomainError("stale_version", 409);
        const clash = (await sameName(tx, project, request.language, request.name)).filter(
          (row) => row.id !== target,
        );
        if (clash.length > 0) throw new DomainError("conflict", 409);
        const diff: ConfigDiffEntry[] = [
          ...(current.name !== request.name
            ? [{ pointer: `/canned/${target}/name`, from: current.name, to: request.name }]
            : []),
          ...(current.language !== request.language
            ? [
                {
                  pointer: `/canned/${target}/language`,
                  from: current.language,
                  to: request.language,
                },
              ]
            : []),
          ...(current.body !== request.body
            ? [{ pointer: `/canned/${target}/body`, from: current.body, to: request.body }]
            : []),
        ];
        return {
          target,
          version: current.version,
          payload: { name: request.name, language: request.language, body: request.body },
          diff,
        };
      },
      apply: (tx, change) =>
        applyCannedPayload(
          tx,
          project,
          "canned.update",
          change.target,
          change.payload,
          principal.id,
          change.diff,
        ),
    },
    options,
  );
}
export async function deleteCannedReply(
  principal: Principal,
  projectId: string,
  replyId: string,
  input: unknown,
  options: { validate?: boolean } = {},
): Promise<ChangeOutcome> {
  const project = writable(principal, projectId);
  const target = id.parse(replyId);
  const request = cannedRemoval.parse(input);
  return submitChange(
    principal,
    project,
    {
      kind: "canned.delete",
      idempotencyKey: request.idempotencyKey,
      prepare: async (tx) => {
        const [current] = await tx
          .select()
          .from(cannedReplies)
          .where(and(eq(cannedReplies.id, target), eq(cannedReplies.projectId, project)));
        if (!current) throw new DomainError("not_found", 404);
        if (current.version !== request.expectedVersion)
          throw new DomainError("stale_version", 409);
        return {
          target,
          version: current.version,
          payload: {},
          diff: [
            { pointer: `/canned/${target}`, from: `${current.language}/${current.name}`, to: null },
          ],
        };
      },
      apply: (tx, change) =>
        applyCannedPayload(
          tx,
          project,
          "canned.delete",
          change.target,
          change.payload,
          principal.id,
          change.diff,
        ),
    },
    options,
  );
}
export async function applyCannedPayload(
  tx: Tx,
  project: string,
  kind: string,
  target: string | null,
  payload: Record<string, unknown>,
  actor: string,
  diff: ConfigDiffEntry[],
): Promise<{ target: string; version: number }> {
  const values = {
    name: String(payload.name),
    language: String(payload.language),
    body: String(payload.body),
  };
  if (kind === "canned.create") {
    if ((await sameName(tx, project, values.language, values.name)).length > 0)
      throw new DomainError("conflict", 409);
    const [made] = await tx
      .insert(cannedReplies)
      .values({ projectId: project, ...values, createdBy: actor })
      .returning({ id: cannedReplies.id });
    if (!made) throw new DomainError("conflict", 409);
    await tx.insert(audit).values({
      projectId: project,
      actorId: actor,
      action: "canned.create",
      targetId: made.id,
      detail: { name: values.name, language: values.language },
    });
    return { target: made.id, version: 1 };
  }
  const [current] = await tx
    .select()
    .from(cannedReplies)
    .where(and(eq(cannedReplies.id, target ?? ""), eq(cannedReplies.projectId, project)))
    .for("update");
  if (!current) throw new DomainError("not_found", 404);
  if (kind === "canned.delete") {
    await tx.delete(cannedReplies).where(eq(cannedReplies.id, current.id));
    await tx.insert(audit).values({
      projectId: project,
      actorId: actor,
      action: "canned.delete",
      targetId: current.id,
      detail: { name: current.name, language: current.language, diff },
    });
    return { target: current.id, version: current.version };
  }
  if (
    (await sameName(tx, project, values.language, values.name)).some((row) => row.id !== current.id)
  )
    throw new DomainError("conflict", 409);
  await tx
    .update(cannedReplies)
    .set({ ...values, version: current.version + 1, updatedAt: new Date() })
    .where(eq(cannedReplies.id, current.id));
  await tx.insert(audit).values({
    projectId: project,
    actorId: actor,
    action: "canned.update",
    targetId: current.id,
    detail: { name: values.name, language: values.language, version: current.version + 1, diff },
  });
  return { target: current.id, version: current.version + 1 };
}
// Whether a proposal was made on a version that has been replaced or removed since.
export async function cannedProposalStale(
  tx: Tx,
  project: string,
  kind: string,
  target: string | null,
  baseVersion: number,
): Promise<boolean> {
  if (kind === "canned.create") return false;
  const [current] = await tx
    .select({ version: cannedReplies.version })
    .from(cannedReplies)
    .where(and(eq(cannedReplies.id, target ?? ""), eq(cannedReplies.projectId, project)))
    .for("update");
  return current?.version !== baseVersion;
}
