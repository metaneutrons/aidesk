"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { Group, Switch } from "./form";
// The stops of the managed agents and the pause of outgoing mail. A project stop is for people
// who may assign tickets, the switches of the whole workspace for an owner. A stop takes back
// the work that is queued or running; lifting it queues nothing, so the tickets that wait are
// queued again by a person.
const levels = z.object({ stopAutonomous: z.boolean(), pauseOutgoing: z.boolean() });
const controlsSchema = z.object({ project: levels, workspace: levels });
export function ProjectAgentControls({ projectId, name }: { projectId: string; name: string }) {
  const t = useTranslations();
  const titleId = useId();
  const [controls, setControls] = useState<z.infer<typeof controlsSchema> | null>(null);
  const [message, setMessage] = useState<{ queued: number } | "error" | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(`/api/v1/projects/${projectId}/agent-controls`).catch(() => null);
    const parsed = response?.ok ? controlsSchema.safeParse(await response.json()) : null;
    if (parsed?.success) setControls(parsed.data);
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function stop(stopped: boolean): Promise<void> {
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${projectId}/agent-stop`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stopped }),
    }).catch(() => null);
    if (!response?.ok) setMessage("error");
    await load();
  }
  async function resume(): Promise<void> {
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${projectId}/resume-agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    const parsed = response?.ok
      ? z.object({ queued: z.number() }).safeParse(await response.json())
      : null;
    setMessage(parsed?.success ? { queued: parsed.data.queued } : "error");
  }
  if (controls === null) return null;
  const stopped = controls.project.stopAutonomous;
  const held = stopped || controls.workspace.stopAutonomous;
  return (
    <section className="connections" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("agentControlsTitle", { project: name })}</h3>
      <p className="muted">{t("agentControlsHint")}</p>
      <Group>
        <div className="row">
          <div className="row-label">
            <span>
              {t(
                controls.workspace.stopAutonomous
                  ? "agentControlsWorkspaceStopped"
                  : stopped
                    ? "agentControlsStopped"
                    : "agentControlsRunning",
              )}
            </span>
            {controls.workspace.pauseOutgoing && (
              <small className="row-hint">{t("agentControlsWorkspacePaused")}</small>
            )}
          </div>
          <div className="row-control">
            <button
              type="button"
              className={stopped ? "secondary" : "primary"}
              onClick={() => {
                void stop(!stopped);
              }}
            >
              {t(stopped ? "agentControlsRelease" : "agentControlsStop")}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={held}
              onClick={() => {
                void resume();
              }}
            >
              {t("agentControlsResume")}
            </button>
          </div>
        </div>
      </Group>
      {message === "error" && (
        <small className="error" role="alert">
          {t("agentControlsError")}
        </small>
      )}
      {message !== null && message !== "error" && (
        <small role="status">{t("agentControlsResumed", { count: message.queued })}</small>
      )}
    </section>
  );
}
export function WorkspaceControls() {
  const t = useTranslations();
  const titleId = useId();
  const [controls, setControls] = useState<z.infer<typeof levels> | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/v1/workspace/controls").catch(() => null);
    const parsed = response?.ok ? levels.safeParse(await response.json()) : null;
    if (parsed?.success) setControls(parsed.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function set(values: Partial<z.infer<typeof levels>>): Promise<void> {
    setFailed(false);
    const response = await fetch("/api/v1/workspace/controls", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    }).catch(() => null);
    if (!response?.ok) setFailed(true);
    await load();
  }
  if (controls === null) return null;
  return (
    <section className="connections" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("workspaceControlsTitle")}</h3>
      <p className="muted">{t("workspaceControlsHint")}</p>
      <Group>
        <Switch
          label={t("workspaceStopAgents")}
          checked={controls.stopAutonomous}
          onChange={(checked) => {
            void set({ stopAutonomous: checked });
          }}
        />
        <Switch
          label={t("workspacePauseOutgoing")}
          checked={controls.pauseOutgoing}
          onChange={(checked) => {
            void set({ pauseOutgoing: checked });
          }}
        />
      </Group>
      {failed && (
        <small className="error" role="alert">
          {t("agentControlsError")}
        </small>
      )}
    </section>
  );
}
