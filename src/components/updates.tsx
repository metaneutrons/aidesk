"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { Actions, Group, Row, Segmented } from "./form";
// The updates of a Compose installation, for the owner: the version that runs, the latest release, the steps of an update
// that is under way and the maintenance window. The updater does the work (see deploy/updater); this page asks it through
// the product and shows what it says. While the containers are replaced the product does not answer for a short time: the
// page keeps asking and says so, and loads itself again when the update is done, because the new version has new files.
const phases = [
  "verifying",
  "backing-up",
  "deploying",
  "waiting-for-health",
  "done",
  "rolling-back",
  "failed",
] as const;
const statusSchema = z.object({
  state: z.enum(["starting", "checking", "current", "available", "updating", "failed"]),
  currentVersion: z.string().nullable(),
  availableVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  releaseCheckStatus: z.enum(["ok", "degraded"]),
  releaseCheckError: z.string().nullable(),
  updaterVersion: z.string().nullable(),
  updateMode: z.enum(["manual", "automatic"]),
  maintenanceTime: z.string(),
  timezone: z.string(),
  updaterSwap: z
    .object({
      outcome: z.enum(["succeeded", "failed", "rolled-back"]),
      detail: z.string().nullable(),
    })
    .nullable(),
  progress: z
    .object({
      phase: z.enum(phases),
      detail: z.string().nullable(),
      failedPhase: z.enum(phases).nullable(),
      rollbackAttempted: z.boolean(),
    })
    .nullable(),
});
const updatesSchema = z.object({
  availability: z.enum(["not-configured", "unreachable", "unauthorized", "ok"]),
  status: statusSchema.nullable(),
});
type Updates = z.infer<typeof updatesSchema>;
type Status = z.infer<typeof statusSchema>;
// The steps that a person sees, in the order they run.
const steps = ["verifying", "backing-up", "deploying", "waiting-for-health"] as const;
// Only the updater's own state counts as running: a step that stayed in the journal of an update that died must not keep
// the page waiting for good.
const busy = (status: Status) => ["updating", "checking", "starting"].includes(status.state);
// All the zones the browser knows, with the one that is set and UTC in the list even where the browser leaves it out.
function zones(current: string): string[] {
  const known = (Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] })
    .supportedValuesOf;
  const all = known ? known("timeZone") : [];
  return [...new Set(["UTC", ...all, current])].sort();
}
export function UpdatesPanel({ locale }: { locale: string }) {
  const t = useTranslations();
  const titleId = useId();
  const [updates, setUpdates] = useState<Updates | null>(null);
  // The product does not answer: it is being replaced, or the connection is gone.
  const [away, setAway] = useState(false);
  // An update was seen under way on this page, so that the page loads itself again when it is done.
  const [watched, setWatched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<"error" | "conflict" | "saved" | null>(null);
  const [draft, setDraft] = useState<{ mode: string; time: string; zone: string } | null>(null);
  const load = useCallback(async (current: () => boolean = () => true) => {
    const response = await fetch("/api/v1/workspace/updates", { cache: "no-store" }).catch(
      () => null,
    );
    if (!current()) return;
    if (!response?.ok) {
      setAway(true);
      return;
    }
    const parsed = updatesSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return;
    setAway(false);
    setUpdates(parsed.data);
    if (parsed.data.status?.state === "updating") setWatched(true);
  }, []);
  useEffect(() => {
    const run = { current: true };
    void load(() => run.current);
    return () => {
      run.current = false;
    };
  }, [load]);
  const status = updates?.status ?? null;
  const active = away || (status !== null && busy(status));
  // Asked every two seconds while something runs; at rest the page asks once.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 2000);
    return () => {
      clearInterval(timer);
    };
  }, [active, load]);
  const done = watched && status?.state === "current" && status.progress?.phase === "done";
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => {
      window.location.reload();
    }, 1500);
    return () => {
      clearTimeout(timer);
    };
  }, [done]);
  async function send(path: string, method: "POST" | "PUT", body?: unknown) {
    setMessage(null);
    const response = await fetch(`/api/v1/workspace/updates${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }).catch(() => null);
    const parsed = response?.ok ? updatesSchema.safeParse(await response.json()) : null;
    if (parsed?.success) {
      setUpdates(parsed.data);
      return true;
    }
    setMessage(response?.status === 409 ? "conflict" : "error");
    await load();
    return false;
  }
  if (updates === null) return null;
  const hint = (kind: Updates["availability"]) =>
    ({
      "not-configured": "updatesNotConfigured",
      unreachable: "updatesUnreachable",
      unauthorized: "updatesUnauthorized",
      ok: "",
    })[kind];
  if (status === null)
    return (
      <section className="connections updates" aria-labelledby={`${titleId}-title`}>
        <h3 id={`${titleId}-title`}>{t("updatesTitle")}</h3>
        <p className="muted">{t(hint(updates.availability))}</p>
      </section>
    );
  const format = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const version = status.availableVersion?.replace(/^v/, "") ?? "";
  const progress = status.progress;
  const failedAt = progress?.phase === "failed" || progress?.phase === "rolling-back";
  // Where each step stands: the ones before the running or the failed step are done, the failed one is marked, the rest wait.
  const stepState = (step: (typeof steps)[number]): "done" | "running" | "failed" | "waiting" => {
    if (!progress) return "waiting";
    if (progress.phase === "done") return "done";
    const index = steps.indexOf(step);
    const stoppedAt = failedAt ? steps.indexOf(progress.failedPhase as (typeof steps)[number]) : -1;
    if (failedAt) {
      if (stoppedAt < 0) return "waiting";
      return index < stoppedAt ? "done" : index === stoppedAt ? "failed" : "waiting";
    }
    const at = steps.indexOf(progress.phase as (typeof steps)[number]);
    return index < at ? "done" : index === at ? "running" : "waiting";
  };
  const shown = draft ?? {
    mode: status.updateMode,
    time: status.maintenanceTime,
    zone: status.timezone,
  };
  const changed =
    shown.mode !== status.updateMode ||
    shown.time !== status.maintenanceTime ||
    shown.zone !== status.timezone;
  const running = status.state === "updating";
  const sentence = (() => {
    if (done) return t("updatesDone", { version });
    if (away) return t("updatesRestarting");
    if (status.state === "updating") return t("updatesInstalling", { version });
    if (status.state === "checking" || status.state === "starting") return t("updatesChecking");
    if (status.state === "available") return t("updatesAvailable", { version });
    if (status.state === "failed") return t("updatesFailed");
    return t("updatesCurrent");
  })();
  return (
    <section className="connections updates" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("updatesTitle")}</h3>
      <p className="muted">{t("updatesHint")}</p>
      <div className="stack">
        <Group title={t("updatesVersion")}>
          <Row label={t("updatesInstalled")}>
            {(props) => (
              <output {...props}>{status.currentVersion ?? t("updatesBuiltHere")}</output>
            )}
          </Row>
          <Row label={t("updatesLatest")}>
            {(props) => <output {...props}>{version || "-"}</output>}
          </Row>
          <Row label={t("updatesChecked")}>
            {(props) => (
              <output {...props}>
                {status.lastCheckedAt ? format.format(new Date(status.lastCheckedAt)) : "-"}
              </output>
            )}
          </Row>
          <Row label={t("updatesUpdater")}>
            {(props) => <output {...props}>{status.updaterVersion ?? "-"}</output>}
          </Row>
        </Group>
        <div className="update-state" role="status" aria-live="polite">
          <strong>{sentence}</strong>
          {status.releaseCheckStatus === "degraded" && (
            <span className="muted">
              {" "}
              {t("updatesCheckDelayed", { reason: status.releaseCheckError ?? "" })}
            </span>
          )}
        </div>
        {/* A failed update says why in the steps below; a failure without steps (the check) says it here. */}
        {status.state === "failed" && !failedAt && status.lastError && (
          <p className="update-error error" role="alert">
            {status.lastError}
          </p>
        )}
        {(running || failedAt || done) && progress && (
          <Group title={t("updatesSteps")}>
            <ol className="update-steps">
              {steps.map((step) => (
                <li key={step} data-state={stepState(step)}>
                  <span>{t(`updatesStep_${step}`)}</span>
                  <small className="muted">{t(`updatesStepState_${stepState(step)}`)}</small>
                </li>
              ))}
            </ol>
            {progress.phase === "rolling-back" && (
              <p className="update-note">{t("updatesRollingBack")}</p>
            )}
            {progress.phase === "failed" && (
              <p className="update-note error" role="alert">
                {t(
                  progress.rollbackAttempted && !progress.detail?.includes("intervention")
                    ? "updatesRolledBack"
                    : "updatesRollbackFailed",
                )}
                {progress.detail && ` (${progress.detail})`}
              </p>
            )}
          </Group>
        )}
        {status.updaterSwap && status.updaterSwap.outcome !== "succeeded" && (
          <p className="error" role="alert">
            {t("updatesSwapFailed", { outcome: status.updaterSwap.outcome })}{" "}
            {status.updaterSwap.detail}
          </p>
        )}
        {message && (
          <p className="error" role="alert">
            {t(message === "conflict" ? "updatesConflict" : "updatesError")}
          </p>
        )}
        {confirming && <p className="update-note">{t("updatesConfirm", { version })}</p>}
        <Actions>
          <button
            type="button"
            className="secondary"
            disabled={running || away}
            onClick={() => {
              void send("/check", "POST");
            }}
          >
            {t("updatesCheck")}
          </button>
          {confirming ? (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setConfirming(false);
                  setWatched(true);
                  void send("/apply", "POST");
                }}
              >
                {t("updatesInstallNow", { version })}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={!status.updateAvailable || running || away}
              onClick={() => {
                setConfirming(true);
              }}
            >
              {version ? t("updatesInstall", { version }) : t("updatesInstallNone")}
            </button>
          )}
        </Actions>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void send("/schedule", "PUT", {
              mode: shown.mode,
              maintenanceTime: shown.time,
              timezone: shown.zone,
            }).then((ok) => {
              if (ok) {
                setDraft(null);
                setMessage("saved");
              }
            });
          }}
        >
          <Group title={t("updatesWindow")} note={t("updatesWindowNote")}>
            <div className="row">
              <div className="row-label">
                <span>{t("updatesMode")}</span>
              </div>
              <div className="row-control">
                <Segmented
                  label={t("updatesMode")}
                  value={shown.mode as "manual" | "automatic"}
                  options={[
                    { value: "manual", label: t("updatesModeManual") },
                    { value: "automatic", label: t("updatesModeAutomatic") },
                  ]}
                  onChange={(mode) => {
                    setDraft({ ...shown, mode });
                  }}
                />
              </div>
            </div>
            <Row label={t("updatesTime")}>
              {(props) => (
                <input
                  {...props}
                  type="time"
                  value={shown.time}
                  required
                  onChange={(event) => {
                    setDraft({ ...shown, time: event.target.value });
                  }}
                />
              )}
            </Row>
            <Row label={t("updatesZone")}>
              {(props) => (
                <select
                  {...props}
                  value={shown.zone}
                  onChange={(event) => {
                    setDraft({ ...shown, zone: event.target.value });
                  }}
                >
                  {zones(status.timezone).map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              )}
            </Row>
          </Group>
          <Actions status={message === "saved" ? <span>{t("updatesSaved")}</span> : undefined}>
            <button type="submit" className="primary" disabled={!changed || running}>
              {t("updatesSave")}
            </button>
          </Actions>
        </form>
      </div>
    </section>
  );
}
