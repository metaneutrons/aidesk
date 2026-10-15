"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { aiTasks } from "../domain/ai";
// The AI tasks of one project: which model provider and model each task uses, its
// limits, and whether it may run. A task that is on sends ticket content to the
// provider of its connection, so the switch says so, and switching on is applied
// only by a person who may approve; for anyone else the button proposes it.
const profileSchema = z.object({
  task: z.enum(aiTasks),
  version: z.number(),
  connectionId: z.string().nullable(),
  model: z.string().nullable(),
  timeoutSeconds: z.number(),
  maxOutputTokens: z.number(),
  dailyTokenBudget: z.number(),
  enabled: z.boolean(),
});
type Profile = z.infer<typeof profileSchema>;
const connectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  direction: z.string(),
  status: z.string(),
});
type Draft = Partial<Omit<Profile, "task" | "version">>;
type Message = "aiApplied" | "aiProposed" | "configStale" | "error";
const taskLabel = (task: Profile["task"]) => `aiTask_${task.replace(".", "_")}` as const;
export function AiProfiles({
  projectId,
  name,
  canWrite,
  canApprove,
  connectionsStamp,
}: {
  projectId: string;
  name: string;
  canWrite: boolean;
  canApprove: boolean;
  connectionsStamp: number;
}) {
  const t = useTranslations();
  const router = useRouter();
  const titleId = useId();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [providers, setProviders] = useState<z.infer<typeof connectionSchema>[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [message, setMessage] = useState<Message | null>(null);
  // Drafts are cleared only after a save, so a slower load never takes away what a
  // person has typed.
  const load = useCallback(
    async (clearDrafts = false) => {
      const response = await fetch(`/api/v1/projects/${projectId}/ai-profiles`).catch(() => null);
      const parsed = response?.ok ? z.array(profileSchema).safeParse(await response.json()) : null;
      if (parsed?.success) {
        setProfiles(parsed.data);
        if (clearDrafts) setDrafts({});
      }
      // Reading connections needs another right; without it the choice is empty.
      const connections = await fetch(`/api/v1/projects/${projectId}/connections`).catch(
        () => null,
      );
      const list = connections?.ok
        ? z.array(connectionSchema).safeParse(await connections.json())
        : null;
      setProviders(list?.success ? list.data.filter((row) => row.direction === "ai") : []);
    },
    [projectId],
  );
  useEffect(() => {
    void load();
  }, [load, connectionsStamp]);
  async function save(profile: Profile, shown: Required<Draft>) {
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${projectId}/ai-profiles/${profile.task}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: profile.version,
        connectionId: shown.connectionId,
        model: shown.model,
        timeoutSeconds: shown.timeoutSeconds,
        maxOutputTokens: shown.maxOutputTokens,
        dailyTokenBudget: shown.dailyTokenBudget,
        enabled: shown.enabled,
        idempotencyKey: crypto.randomUUID(),
      }),
    }).catch(() => null);
    if (!response?.ok) setMessage(response?.status === 409 ? "configStale" : "error");
    else setMessage(response.status === 202 ? "aiProposed" : "aiApplied");
    await load(true);
    router.refresh();
  }
  if (profiles === null) return null;
  return (
    <section className="ai-profiles" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("aiProfilesTitle", { project: name })}</h3>
      <p className="muted">{t("aiProfilesHint")}</p>
      {providers.length === 0 && <p className="muted">{t("aiNoProviders")}</p>}
      {profiles.map((profile) => {
        const id = profile.task;
        const draft = drafts[id] ?? {};
        const shown = {
          connectionId: draft.connectionId ?? profile.connectionId ?? providers[0]?.id ?? "",
          model: draft.model ?? profile.model ?? "",
          timeoutSeconds: draft.timeoutSeconds ?? profile.timeoutSeconds,
          maxOutputTokens: draft.maxOutputTokens ?? profile.maxOutputTokens,
          dailyTokenBudget: draft.dailyTokenBudget ?? profile.dailyTokenBudget,
          enabled: draft.enabled ?? profile.enabled,
        };
        const change = (values: Draft) => {
          setDrafts({ ...drafts, [id]: { ...draft, ...values } });
        };
        const changed =
          shown.connectionId !== (profile.connectionId ?? "") ||
          shown.model !== (profile.model ?? "") ||
          shown.timeoutSeconds !== profile.timeoutSeconds ||
          shown.maxOutputTokens !== profile.maxOutputTokens ||
          shown.dailyTokenBudget !== profile.dailyTokenBudget ||
          shown.enabled !== profile.enabled;
        // Switching on, or pointing a task that is on at another provider, needs a
        // person who may approve.
        const needsApproval =
          shown.enabled && (!profile.enabled || shown.connectionId !== profile.connectionId);
        const ready =
          shown.connectionId !== "" && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(shown.model);
        const known = providers.some((row) => row.id === shown.connectionId);
        return (
          <fieldset key={id} className="ai-profile" disabled={!canWrite}>
            <legend>{t(taskLabel(profile.task))}</legend>
            <label>
              <span>{t("aiConnection")}</span>
              <select
                value={shown.connectionId}
                onChange={(event) => {
                  change({ connectionId: event.target.value });
                }}
              >
                {!known && shown.connectionId !== "" && (
                  <option value={shown.connectionId}>{t("aiConnectionCurrent")}</option>
                )}
                {providers.length === 0 && shown.connectionId === "" && (
                  <option value="">{t("aiConnectionNone")}</option>
                )}
                {providers.map((row) => (
                  <option key={row.id} value={row.id} disabled={row.status === "disabled"}>
                    {`${row.name} (${t(`connectionKind_${row.kind}`)})`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("aiModel")}</span>
              <input
                type="text"
                value={shown.model}
                maxLength={100}
                onChange={(event) => {
                  change({ model: event.target.value });
                }}
              />
            </label>
            <label>
              <span>{t("aiTimeout")}</span>
              <input
                type="number"
                min={1}
                max={300}
                value={shown.timeoutSeconds}
                onChange={(event) => {
                  change({ timeoutSeconds: Number(event.target.value) });
                }}
              />
            </label>
            <label>
              <span>{t("aiMaxOutput")}</span>
              <input
                type="number"
                min={1}
                max={16000}
                value={shown.maxOutputTokens}
                onChange={(event) => {
                  change({ maxOutputTokens: Number(event.target.value) });
                }}
              />
            </label>
            <label>
              <span>{t("aiDailyBudget")}</span>
              <input
                type="number"
                min={1}
                max={100000000}
                value={shown.dailyTokenBudget}
                onChange={(event) => {
                  change({ dailyTokenBudget: Number(event.target.value) });
                }}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={shown.enabled}
                onChange={(event) => {
                  change({ enabled: event.target.checked });
                }}
              />
              <span>{t("aiEnabled")}</span>
            </label>
            <p className="muted">{t("aiEnabledHint")}</p>
            {canWrite && (
              <span className="configuration-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={!changed || !ready}
                  onClick={() => {
                    void save(profile, shown);
                  }}
                >
                  {t(needsApproval && !canApprove ? "aiPropose" : "aiSave")}
                </button>
              </span>
            )}
          </fieldset>
        );
      })}
      {message && (
        <p
          className={message === "error" || message === "configStale" ? "error" : "muted"}
          role="status"
        >
          {t(message)}
        </p>
      )}
    </section>
  );
}
