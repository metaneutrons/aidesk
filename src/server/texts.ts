import { and, desc, eq, sql } from "drizzle-orm";
import { z, ZodError } from "zod";
import type { ConfigDiffEntry } from "../domain/configuration";
import { permits, type Principal } from "../domain/permissions";
import {
  baseLanguage,
  isTextKey,
  isTextLanguage,
  textKeyNames,
  type TextKey,
  textKeys,
  textLanguages,
  textProblems,
  type TextKeyName,
  type TextLanguage,
} from "../domain/texts";
import { submitChange, type ChangeOutcome, type Tx } from "./changes";
import { db } from "./db";
import { audit, projectTexts } from "./db/schema";
import { DomainError } from "./errors";
const id = z.uuid();
export const textWrite = z
  .object({
    // The wording, or null to return to the built-in one.
    text: z.string().nullable(),
    // The version that was read: 0 when the project has set nothing yet.
    expectedVersion: z.number().int().min(0),
    idempotencyKey: z.uuid().optional(),
  })
  .strict();
function readable(principal: Principal, project: string): void {
  if (!permits(principal, project, "config.read")) throw new DomainError("not_found", 404);
}
function parseTarget(key: string, language: string): { key: TextKeyName; language: TextLanguage } {
  if (!isTextKey(key))
    throw new ZodError([{ code: "custom", path: ["key"], message: "Unknown key" }]);
  if (!isTextLanguage(language))
    throw new ZodError([{ code: "custom", path: ["language"], message: "Use en or de" }]);
  return { key, language };
}
// The latest version of a text and what it says (null when it returns to the
// built-in wording or was never set).
async function latest(tx: Pick<Tx, "select">, project: string, key: string, language: string) {
  const [row] = await tx
    .select({ version: projectTexts.version, text: projectTexts.text })
    .from(projectTexts)
    .where(
      and(
        eq(projectTexts.projectId, project),
        eq(projectTexts.key, key),
        eq(projectTexts.language, language),
      ),
    )
    .orderBy(desc(projectTexts.version))
    .limit(1);
  return { version: row?.version ?? 0, text: row?.text ?? null };
}
// The wording in use for one language: only what the project has set, by key.
export async function activeTexts(
  projectId: string,
  language: string,
): Promise<Partial<Record<string, string>>> {
  const rows = await db().execute<{ key: string; text: string | null }>(sql`
    select distinct on (key) key, text from ${projectTexts}
    where project_id = ${projectId} and language = ${baseLanguage(language)}
    order by key, version desc`);
  return Object.fromEntries(
    rows.flatMap((row) => (row.text !== null && isTextKey(row.key) ? [[row.key, row.text]] : [])),
  );
}
// Every text the project can set, with the built-in wording, the project's own
// wording and the version to name when changing it.
export async function listTexts(principal: Principal, projectId: string) {
  const project = id.parse(projectId);
  readable(principal, project);
  const rows = await db().execute<{
    key: string;
    language: string;
    version: number;
    text: string | null;
  }>(sql`
    select distinct on (key, language) key, language, version, text from ${projectTexts}
    where project_id = ${project} order by key, language, version desc`);
  return textKeyNames.map((key) => {
    const entry: TextKey = textKeys[key];
    const languages = Object.fromEntries(
      textLanguages.map((language) => {
        const own = rows.find((row) => row.key === key && row.language === language);
        return [
          language,
          { default: entry.defaults[language], own: own?.text ?? null, version: own?.version ?? 0 },
        ];
      }),
    ) as Record<TextLanguage, { default: string; own: string | null; version: number }>;
    return {
      key,
      description: entry.description,
      placeholders: [...entry.placeholders],
      required: [...entry.required],
      languages,
    };
  });
}
export async function listTextVersions(
  principal: Principal,
  projectId: string,
  keyName: string,
  languageName: string,
) {
  const project = id.parse(projectId);
  readable(principal, project);
  const { key, language } = parseTarget(keyName, languageName);
  return db()
    .select({
      version: projectTexts.version,
      text: projectTexts.text,
      createdBy: projectTexts.createdBy,
      createdAt: projectTexts.createdAt,
    })
    .from(projectTexts)
    .where(
      and(
        eq(projectTexts.projectId, project),
        eq(projectTexts.key, key),
        eq(projectTexts.language, language),
      ),
    )
    .orderBy(desc(projectTexts.version));
}
export async function applyTextPayload(
  tx: Tx,
  project: string,
  payload: Record<string, unknown>,
  actor: string,
  diff: ConfigDiffEntry[],
): Promise<{ target: string; version: number }> {
  const key = String(payload.key);
  const language = String(payload.language);
  const version = (await latest(tx, project, key, language)).version + 1;
  await tx.insert(projectTexts).values({
    projectId: project,
    key,
    language,
    version,
    text: typeof payload.text === "string" ? payload.text : null,
    createdBy: actor,
  });
  await tx.insert(audit).values({
    projectId: project,
    actorId: actor,
    action: "text.set",
    targetId: `${key}:${language}`,
    detail: { version, diff },
  });
  return { target: `${key}:${language}`, version };
}
// Whether a proposal was made on a version that has been replaced since.
export async function textProposalStale(
  tx: Tx,
  project: string,
  payload: Record<string, unknown>,
  baseVersion: number,
): Promise<boolean> {
  return (
    (await latest(tx, project, String(payload.key), String(payload.language))).version !==
    baseVersion
  );
}
// Sets the wording of one text in one language, or returns it to the built-in
// one with null. A person applies it; an agent proposes it under the review
// policy.
export async function setText(
  principal: Principal,
  projectId: string,
  keyName: string,
  languageName: string,
  input: unknown,
  options: { validate?: boolean } = {},
): Promise<ChangeOutcome> {
  const project = id.parse(projectId);
  readable(principal, project);
  if (!permits(principal, project, "config.write")) throw new DomainError("forbidden", 403);
  const { key, language } = parseTarget(keyName, languageName);
  const request = textWrite.parse(input);
  if (request.text !== null) {
    const problems = textProblems(key, request.text);
    if (problems.length > 0)
      throw new ZodError(problems.map((message) => ({ code: "custom", path: ["text"], message })));
  }
  return submitChange(
    principal,
    project,
    {
      kind: "text.set",
      idempotencyKey: request.idempotencyKey,
      prepare: async (tx) => {
        const current = await latest(tx, project, key, language);
        if (request.expectedVersion !== current.version)
          throw new DomainError("stale_version", 409);
        return {
          target: `${key}:${language}`,
          version: current.version,
          payload: { key, language, text: request.text },
          diff:
            current.text === request.text
              ? []
              : [{ pointer: `/texts/${key}/${language}`, from: current.text, to: request.text }],
        };
      },
      apply: (tx, change) =>
        applyTextPayload(tx, project, change.payload, principal.id, change.diff),
    },
    options,
  );
}
