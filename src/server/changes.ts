import { and, eq } from "drizzle-orm";
import type { ConfigDiffEntry } from "../domain/configuration";
import type { Principal } from "../domain/permissions";
import { db } from "./db";
import { audit, configChanges, projects } from "./db/schema";
import { DomainError } from "./errors";
export type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
export interface ChangeOutcome {
  outcome: "unchanged" | "applied" | "proposed";
  // What the change concerns, for example a connection id, and its version.
  target: string | null;
  version: number | null;
  changeId: string | null;
  diff: ConfigDiffEntry[];
  // True when nothing was written: the outcome says what a real write would do.
  validated: boolean;
}
export interface ChangeSpec {
  // Recorded with the change, for example "connection.update" or "text.set".
  kind: string;
  idempotencyKey: string | undefined;
  // Runs inside the transaction once the project is locked: loads what is
  // changed, checks the version the writer read (stale_version) and describes the
  // change. A payload may carry a sealed secret, never a plain one.
  prepare: (tx: Tx) => Promise<{
    target: string | null;
    version: number | null;
    payload: Record<string, unknown>;
    diff: ConfigDiffEntry[];
  }>;
  // Applies the payload, inside the same transaction.
  apply: (
    tx: Tx,
    change: { target: string | null; payload: Record<string, unknown>; diff: ConfigDiffEntry[] },
  ) => Promise<{ target: string | null; version: number }>;
}
// The one path of every change of project configuration other than the
// configuration document itself: serialized per project, idempotent, checked
// against the version that was read, and either applied or kept as a proposal.
// People apply directly; an agent proposes under the review policy. The caller
// has checked that the principal may make this kind of change.
export async function submitChange(
  principal: Principal,
  project: string,
  spec: ChangeSpec,
  options: { validate?: boolean },
): Promise<ChangeOutcome> {
  return db().transaction(async (tx) => {
    const [owner] = await tx
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, project))
      .for("update");
    if (!owner) throw new DomainError("not_found", 404);
    if (spec.idempotencyKey && !options.validate) {
      const [earlier] = await tx
        .select()
        .from(configChanges)
        .where(
          and(
            eq(configChanges.projectId, project),
            eq(configChanges.idempotencyKey, spec.idempotencyKey),
          ),
        );
      if (earlier) {
        if (earlier.proposedBy !== principal.id || earlier.kind !== spec.kind)
          throw new DomainError("idempotency_conflict", 409);
        return {
          outcome: earlier.status === "applied" ? "applied" : "proposed",
          target: earlier.target,
          version: earlier.appliedVersion,
          changeId: earlier.id,
          diff: earlier.diff,
          validated: false,
        };
      }
    }
    const prepared = await spec.prepare(tx);
    const { payload, diff } = prepared;
    const current = { target: prepared.target, version: prepared.version };
    if (diff.length === 0)
      return {
        outcome: "unchanged",
        ...current,
        changeId: null,
        diff,
        validated: options.validate === true,
      };
    const direct = principal.kind === "human" || owner.settings.approvalPolicy === "direct";
    if (options.validate)
      return {
        outcome: direct ? "applied" : "proposed",
        ...current,
        changeId: null,
        diff,
        validated: true,
      };
    const base = {
      projectId: project,
      kind: spec.kind,
      target: prepared.target,
      baseVersion: prepared.version ?? 0,
      proposedBy: principal.id,
      proposerKind: principal.kind,
      idempotencyKey: spec.idempotencyKey ?? null,
      payload,
      diff,
    };
    if (!direct) {
      const [change] = await tx
        .insert(configChanges)
        .values({ ...base, status: "pending" })
        .returning({ id: configChanges.id });
      if (!change) throw new DomainError("conflict", 409);
      await tx.insert(audit).values({
        projectId: project,
        actorId: principal.id,
        action: "change.propose",
        targetId: change.id,
        detail: { kind: spec.kind, target: prepared.target, diff },
      });
      return { outcome: "proposed", ...current, changeId: change.id, diff, validated: false };
    }
    const applied = await spec.apply(tx, { target: prepared.target, payload, diff });
    const [change] = await tx
      .insert(configChanges)
      .values({
        ...base,
        target: applied.target,
        status: "applied",
        appliedVersion: applied.version,
        decidedAt: new Date(),
      })
      .returning({ id: configChanges.id });
    if (!change) throw new DomainError("conflict", 409);
    return {
      outcome: "applied",
      target: applied.target,
      version: applied.version,
      changeId: change.id,
      diff,
      validated: false,
    };
  });
}
