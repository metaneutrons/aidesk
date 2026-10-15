// What a person sees of the AI work on a ticket, in few words. It is derived from the latest run
// of the managed agent that is assigned and from the stops that hold; a ticket that is not
// assigned to a managed agent, or one with nothing run and nothing stopped, has none.
export const aiWorkStates = [
  "queued",
  "running",
  "draft_ready",
  "sent",
  "done",
  "failed",
  "stopped",
  "needs_person",
] as const;
export type AiWorkState = (typeof aiWorkStates)[number];
// Where a stop that holds was set.
export const stopLevels = ["ticket", "project", "workspace"] as const;
export type StopLevel = (typeof stopLevels)[number];
export interface AiWork {
  state: AiWorkState;
  runId: string | null;
  reason: string | null;
  at: Date | null;
  stoppedBy: StopLevel | null;
}
const stoppedReasons = ["stopped", "workspace_stopped", "taken_over"];
// A stop that holds wins over what the last run did: a person who looks at the ticket has to
// see that nothing more will happen until they decide.
export function aiWork(
  run: {
    id: string;
    state: string;
    reason: string | null;
    endedAt: Date | null;
    createdAt: Date;
  } | null,
  stop: StopLevel | null,
): AiWork | null {
  const at = run ? (run.endedAt ?? run.createdAt) : null;
  const base = { runId: run?.id ?? null, reason: run?.reason ?? null, at, stoppedBy: stop };
  if (stop !== null) return { ...base, state: "stopped" };
  if (!run) return null;
  switch (run.state) {
    case "queued":
    case "running":
    case "draft_ready":
    case "failed":
    case "needs_person":
      return { ...base, state: run.state };
    case "sent":
    case "resolved":
      return { ...base, state: "sent" };
    case "cancelled":
      return { ...base, state: stoppedReasons.includes(run.reason ?? "") ? "stopped" : "done" };
    default:
      return { ...base, state: "done" };
  }
}
