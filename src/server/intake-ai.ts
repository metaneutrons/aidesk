import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  assemble,
  classifyTool,
  extractPrompt,
  extractSystem,
  extractTool,
  intakeLimits,
  junkPrompt,
  junkSystem,
  textLines,
  type ExtractResult,
  type JunkResult,
} from "../domain/intake";
import { cleanText } from "../domain/untrusted";
import { runAiTask, type AiDeps } from "./ai-run";
import { db } from "./db";
import { aiProfiles, ingress } from "./db/schema";
// The two steps of intake that ask a model: the new content of a mail (extraction) and whether a
// mail is junk. Each is switched on by a profile of its own and is optional: when it is off, fails
// or is not sure, the parser and the rules stay the result and the failure stays visible. The
// calls are made before the transaction of the intake, after the raw mail is stored, and in
// parallel, each bounded in time, so that a slow provider delays the mail by seconds and never
// holds a lock. A result is stored with the mail, so that a mail that is processed again after a
// crash is not sent to the model again.
export interface IntakeMail {
  projectId: string;
  ingressId: string;
  subject: string;
  from: string;
  // The text of the mail as the parser read it, with the quoted history.
  body: string;
  attachments: number;
  signals: string[];
  // A reply that continues a ticket is not asked about junk.
  wantJunk: boolean;
  // Results of an earlier run of this mail.
  stored?: { extract?: ExtractResult; junk?: JunkResult } | undefined;
}
export interface IntakeResult {
  extract: ExtractResult | null;
  junk: JunkResult | null;
}
const actor = { id: "intake", kind: "system" } as const;
const boundary = () => `mail-${randomBytes(12).toString("hex")}`;
async function enabledTasks(projectId: string): Promise<Set<string>> {
  const rows = await db()
    .select({ task: aiProfiles.task })
    .from(aiProfiles)
    .where(
      and(
        eq(aiProfiles.projectId, projectId),
        eq(aiProfiles.enabled, true),
        inArray(aiProfiles.task, ["intake.extract", "intake.junk"]),
      ),
    );
  return new Set(rows.map((row) => row.task));
}
async function extract(mail: IntakeMail, deps: AiDeps): Promise<ExtractResult> {
  if (mail.body.length > intakeLimits.extractChars)
    return { state: "skipped", code: "context_limit" };
  const lines = textLines(mail.body);
  const marker = boundary();
  const outcome = await runAiTask(
    {
      projectId: mail.projectId,
      task: "intake.extract",
      system: extractSystem(marker),
      prompt: extractPrompt(
        marker,
        lines.map((line) => cleanText(line).text),
      ),
      tools: { select: extractTool },
      maxWaitSeconds: intakeLimits.waitSeconds,
      actor,
    },
    deps,
  );
  if (!outcome.ok) return { state: "failed", code: outcome.code, runId: outcome.runId };
  const call = outcome.toolCalls.find((entry) => entry.name === "select");
  const parsed = call ? extractTool.schema.safeParse(call.input) : null;
  if (!parsed?.success) return { state: "failed", code: "no_selection", runId: outcome.runId };
  // The ranges have to fit the mail and hold something: the check is the assembly itself.
  if (assemble(lines, parsed.data.keep) === null)
    return { state: "failed", code: "bad_selection", runId: outcome.runId };
  return {
    state: "ok",
    keep: parsed.data.keep,
    uncertain: parsed.data.uncertain,
    runId: outcome.runId,
  };
}
async function classify(mail: IntakeMail, deps: AiDeps): Promise<JunkResult> {
  const marker = boundary();
  const outcome = await runAiTask(
    {
      projectId: mail.projectId,
      task: "intake.junk",
      system: junkSystem(marker),
      prompt: junkPrompt(marker, {
        subject: cleanText(mail.subject).text,
        from: cleanText(mail.from).text,
        text: cleanText(mail.body).text,
        attachments: mail.attachments,
        signals: mail.signals,
      }),
      tools: { classify: classifyTool },
      maxWaitSeconds: intakeLimits.waitSeconds,
      actor,
    },
    deps,
  );
  if (!outcome.ok) return { state: "failed", code: outcome.code, runId: outcome.runId };
  const call = outcome.toolCalls.find((entry) => entry.name === "classify");
  const parsed = call ? classifyTool.schema.safeParse(call.input) : null;
  if (!parsed?.success) return { state: "failed", code: "no_verdict", runId: outcome.runId };
  return { state: parsed.data.verdict, reason: parsed.data.reason, runId: outcome.runId };
}
export async function runIntakeAi(mail: IntakeMail, deps: AiDeps = {}): Promise<IntakeResult> {
  const enabled = await enabledTasks(mail.projectId);
  const stored = mail.stored ?? {};
  const [extracted, junk] = await Promise.all([
    enabled.has("intake.extract")
      ? (stored.extract ?? extract(mail, deps))
      : Promise.resolve<ExtractResult | null>(null),
    enabled.has("intake.junk") && mail.wantJunk
      ? (stored.junk ?? classify(mail, deps))
      : Promise.resolve<JunkResult | null>(null),
  ]);
  const fresh = {
    ...(extracted && extracted !== stored.extract ? { extract: extracted } : {}),
    ...(junk && junk !== stored.junk ? { junk } : {}),
  };
  if (Object.keys(fresh).length > 0)
    await db()
      .update(ingress)
      .set({
        classification: sql`coalesce(${ingress.classification}, '{}'::jsonb) || jsonb_build_object('ai', coalesce(${ingress.classification}->'ai', '{}'::jsonb) || ${JSON.stringify(fresh)}::jsonb)`,
      })
      .where(eq(ingress.id, mail.ingressId));
  return { extract: extracted, junk };
}
