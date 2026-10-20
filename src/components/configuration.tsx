"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { z } from "zod";
import { parseDays } from "../domain/business-hours";
import { configDocument, type ConfigDocument } from "../domain/configuration";
// The configuration of one project as the REST API offers it: read with its
// version, checked or saved as a whole, and the changes waiting for approval.
const readSchema = z.object({ version: z.number(), config: configDocument });
const outgoingSchema = z.array(
  z.object({ id: z.string(), name: z.string(), direction: z.string(), status: z.string() }),
);
const diffSchema = z.array(z.object({ pointer: z.string(), from: z.unknown(), to: z.unknown() }));
const resultSchema = z.object({
  outcome: z.enum(["unchanged", "applied", "proposed"]),
  validated: z.boolean(),
  diff: diffSchema,
});
const changeSchema = z.object({
  id: z.string(),
  status: z.string(),
  proposedBy: z.string(),
  proposerKind: z.enum(["human", "agent"]),
  diff: diffSchema,
});
type Message = "configApplied" | "configProposed" | "configUnchanged" | "configStale" | "error";
// The seven weekdays, Monday first, as ISO numbers; the names come from the locale.
const weekdays = [1, 2, 3, 4, 5, 6, 7];
const weekdayName = (day: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2024, 0, day)),
  );
// The limits that a priority sets for itself, and the text of each; an empty field takes the limit of the project.
const priorityFields = [
  ["warnHoursLow", "configWarnLow"],
  ["overdueHoursLow", "configOverdueLow"],
  ["warnHoursHigh", "configWarnHigh"],
  ["overdueHoursHigh", "configOverdueHigh"],
  ["warnHoursUrgent", "configWarnUrgent"],
  ["overdueHoursUrgent", "configOverdueUrgent"],
] as const;
const show = (value: unknown) =>
  typeof value === "boolean" ? String(value) : typeof value === "string" ? value : "";
export function Configuration({
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
  const locale = useLocale();
  const router = useRouter();
  const fieldId = useId();
  const [version, setVersion] = useState<number | null>(null);
  const [saved, setSaved] = useState<ConfigDocument | null>(null);
  const [draft, setDraft] = useState<ConfigDocument | null>(null);
  const [outgoing, setOutgoing] = useState<z.infer<typeof outgoingSchema>>([]);
  const [changes, setChanges] = useState<z.infer<typeof changeSchema>[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  // True once the person has changed a field; a slower load must not take the
  // edit away. A save or a decision starts from the stored values again.
  const edited = useRef(false);
  const [checked, setChecked] = useState<z.infer<typeof diffSchema> | null>(null);
  const load = useCallback(
    async (keepDraft = false) => {
      const [read, list, connectionList] = await Promise.all([
        fetch(`/api/v1/projects/${projectId}/config`).catch(() => null),
        fetch(`/api/v1/projects/${projectId}/config/changes?status=pending`).catch(() => null),
        fetch(`/api/v1/projects/${projectId}/connections`).catch(() => null),
      ]);
      // Only people who manage connections can list them; others see the current one.
      const found = connectionList?.ok
        ? outgoingSchema.safeParse(await connectionList.json())
        : null;
      if (found?.success) setOutgoing(found.data.filter((entry) => entry.direction === "outbound"));
      const parsed = read?.ok ? readSchema.safeParse(await read.json()) : null;
      if (parsed?.success) {
        setVersion(parsed.data.version);
        setSaved(parsed.data.config);
        if (!keepDraft && !edited.current) setDraft(parsed.data.config);
      }
      const pending = list?.ok ? z.array(changeSchema).safeParse(await list.json()) : null;
      if (pending?.success) setChanges(pending.data);
    },
    [projectId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // The connections to choose from; reloaded when the list of connections
  // changed elsewhere on the page. Only people who manage connections can list
  // them; others see the current one.
  useEffect(() => {
    void (async () => {
      const response = await fetch(`/api/v1/projects/${projectId}/connections`).catch(() => null);
      const found = response?.ok ? outgoingSchema.safeParse(await response.json()) : null;
      if (found?.success) setOutgoing(found.data.filter((entry) => entry.direction === "outbound"));
    })();
  }, [projectId, connectionsStamp]);
  async function write(validate: boolean) {
    if (!draft || version === null) return;
    setMessage(null);
    const response = await fetch(
      `/api/v1/projects/${projectId}/config${validate ? "?validate=true" : ""}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: draft,
          expectedVersion: version,
          idempotencyKey: crypto.randomUUID(),
        }),
      },
    ).catch(() => null);
    if (response?.status === 409) {
      setMessage("configStale");
      // The current values are loaded; the edit in the form stays.
      await load(true);
      return;
    }
    const parsed = response?.ok ? resultSchema.safeParse(await response.json()) : null;
    if (!parsed?.success) {
      setMessage("error");
      return;
    }
    setChecked(validate ? parsed.data.diff : null);
    if (validate) return;
    edited.current = false;
    setMessage(
      parsed.data.outcome === "applied"
        ? "configApplied"
        : parsed.data.outcome === "proposed"
          ? "configProposed"
          : "configUnchanged",
    );
    await load();
    // The rest of the desk (project list, overview) shows the new values.
    router.refresh();
  }
  async function decide(changeId: string, decision: "approve" | "reject") {
    const response = await fetch(`/api/v1/config/changes/${changeId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    }).catch(() => null);
    setMessage(response?.ok ? null : response?.status === 409 ? "configStale" : "error");
    edited.current = false;
    await load();
    router.refresh();
  }
  if (!draft || !saved) return null;
  const set = <K extends keyof ConfigDocument>(key: K, value: ConfigDocument[K]) => {
    edited.current = true;
    setDraft({ ...draft, [key]: value });
    setChecked(null);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const valid = configDocument.safeParse(draft).success;
  const businessOn = draft.businessDays !== null;
  const businessDays = parseDays(draft.businessDays ?? "") ?? [];
  const zones: string[] = Intl.supportedValuesOf("timeZone");
  return (
    <section className="configuration" aria-labelledby={`${fieldId}-title`}>
      <h3 id={`${fieldId}-title`}>{t("configTitle", { project: name })}</h3>
      <div className="configuration-fields">
        <label>
          {t("configName")}
          <input
            value={draft.name}
            disabled={!canWrite}
            maxLength={100}
            onChange={(event) => {
              set("name", event.target.value);
            }}
          />
        </label>
        <label>
          {t("configColor")}
          <input
            type="color"
            value={draft.color}
            disabled={!canWrite}
            onChange={(event) => {
              set("color", event.target.value);
            }}
          />
        </label>
        <label>
          {t("configLanguage")}
          <select
            value={draft.defaultLanguage}
            disabled={!canWrite}
            onChange={(event) => {
              set("defaultLanguage", event.target.value === "de" ? "de" : "en");
            }}
          >
            <option value="en">English</option>
            <option value="de">Deutsch</option>
          </select>
        </label>
        <label>
          {t("configPolicy")}
          <select
            value={draft.approvalPolicy}
            disabled={!canApprove}
            onChange={(event) => {
              set("approvalPolicy", event.target.value === "direct" ? "direct" : "review");
            }}
          >
            <option value="review">{t("configPolicyReview")}</option>
            <option value="direct">{t("configPolicyDirect")}</option>
          </select>
        </label>
        <label className="configuration-check">
          <input
            type="checkbox"
            checked={draft.acknowledgements}
            disabled={!canWrite}
            aria-describedby={`${fieldId}-ack`}
            onChange={(event) => {
              set("acknowledgements", event.target.checked);
            }}
          />
          {t("configAcknowledgements")}
        </label>
        <p id={`${fieldId}-ack`} className="muted">
          {t("acknowledgementHint")}
        </p>
        <label className="configuration-check">
          <input
            type="checkbox"
            checked={draft.portalLinks}
            disabled={!canWrite}
            aria-describedby={`${fieldId}-links`}
            onChange={(event) => {
              set("portalLinks", event.target.checked);
            }}
          />
          {t("configPortalLinks")}
        </label>
        <p id={`${fieldId}-links`} className="muted">
          {t("portalLinksHint")}
        </p>
        <label>
          {t("configOutgoing")}
          <select
            value={draft.outboundConnectionId ?? ""}
            disabled={!canWrite}
            onChange={(event) => {
              set("outboundConnectionId", event.target.value === "" ? null : event.target.value);
            }}
          >
            <option value="">{t("configOutgoingNone")}</option>
            {draft.outboundConnectionId &&
              !outgoing.some((entry) => entry.id === draft.outboundConnectionId) && (
                <option value={draft.outboundConnectionId}>{draft.outboundConnectionId}</option>
              )}
            {outgoing
              .filter((entry) => entry.status !== "disabled")
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {t("configWarn")}
          <input
            type="number"
            min={1}
            max={720}
            value={draft.warnHours}
            disabled={!canWrite}
            onChange={(event) => {
              set(
                "warnHours",
                Math.min(720, Math.max(1, Math.trunc(Number(event.target.value) || 1))),
              );
            }}
          />
        </label>
        <label>
          {t("configOverdue")}
          <input
            type="number"
            min={1}
            max={720}
            value={draft.overdueHours}
            disabled={!canWrite}
            onChange={(event) => {
              set(
                "overdueHours",
                Math.min(720, Math.max(1, Math.trunc(Number(event.target.value) || 1))),
              );
            }}
          />
        </label>
        <label>
          {t("configJunkSensitivity")}
          <select
            value={draft.junkSensitivity}
            disabled={!canWrite}
            onChange={(event) => {
              set("junkSensitivity", event.target.value as typeof draft.junkSensitivity);
            }}
          >
            <option value="off">{t("configJunkSensitivityOff")}</option>
            <option value="standard">{t("configJunkSensitivityStandard")}</option>
            <option value="strict">{t("configJunkSensitivityStrict")}</option>
          </select>
        </label>
        <label>
          {t("configReopenMode")}
          <select
            value={draft.reopenMode}
            disabled={!canWrite}
            onChange={(event) => {
              set("reopenMode", event.target.value as typeof draft.reopenMode);
            }}
          >
            <option value="reopen">{t("configReopenModeReopen")}</option>
            <option value="new_ticket">{t("configReopenModeNew")}</option>
            <option value="refuse">{t("configReopenModeRefuse")}</option>
          </select>
        </label>
        <label>
          {t("configReopenDays")}
          <input
            type="number"
            min={1}
            max={365}
            value={draft.reopenDays}
            disabled={!canWrite || draft.reopenMode !== "reopen"}
            onChange={(event) => {
              set(
                "reopenDays",
                Math.min(365, Math.max(1, Math.trunc(Number(event.target.value) || 1))),
              );
            }}
          />
        </label>
        <label>
          {t("configAutoResolve")}
          <input
            type="number"
            min={1}
            max={365}
            value={draft.autoResolveDays ?? ""}
            placeholder={t("configAutoResolveOff")}
            disabled={!canWrite}
            onChange={(event) => {
              const days = Math.trunc(Number(event.target.value));
              set(
                "autoResolveDays",
                event.target.value === "" ? null : Math.min(365, Math.max(1, days || 1)),
              );
              if (event.target.value === "") set("autoResolveReminderDays", null);
            }}
          />
        </label>
        <label>
          {t("configAutoResolveReminder")}
          <input
            type="number"
            min={1}
            max={364}
            value={draft.autoResolveReminderDays ?? ""}
            placeholder={t("configAutoResolveOff")}
            disabled={!canWrite || draft.autoResolveDays === null}
            onChange={(event) => {
              const days = Math.trunc(Number(event.target.value));
              set(
                "autoResolveReminderDays",
                event.target.value === ""
                  ? null
                  : Math.min((draft.autoResolveDays ?? 2) - 1, Math.max(1, days || 1)),
              );
            }}
          />
        </label>
        {priorityFields.map(([key, label]) => (
          <label key={key}>
            {t(label)}
            <input
              type="number"
              min={1}
              max={720}
              value={draft[key] ?? ""}
              placeholder="–"
              disabled={!canWrite}
              onChange={(event) => {
                set(
                  key,
                  event.target.value === ""
                    ? null
                    : Math.min(720, Math.max(1, Math.trunc(Number(event.target.value)) || 1)),
                );
              }}
            />
          </label>
        ))}
        <label>
          {t("configCategories")}
          <textarea
            rows={3}
            value={draft.categories}
            disabled={!canWrite}
            maxLength={2050}
            onChange={(event) => {
              set("categories", event.target.value);
            }}
          />
        </label>
        <label className="configuration-check">
          <input
            type="checkbox"
            checked={businessOn}
            disabled={!canWrite}
            onChange={(event) => {
              setDraft({
                ...draft,
                businessDays: event.target.checked ? "1,2,3,4,5" : null,
                businessTimeZone: event.target.checked
                  ? (draft.businessTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
                  : draft.businessTimeZone,
              });
              edited.current = true;
              setChecked(null);
            }}
          />
          {t("configBusinessHours")}
        </label>
        <fieldset className="business-days" disabled={!canWrite || !businessOn}>
          <legend>{t("configBusinessDays")}</legend>
          {weekdays.map((day) => (
            <label key={day} className="configuration-check">
              <input
                type="checkbox"
                checked={businessDays.includes(day)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...businessDays, day]
                    : businessDays.filter((entry) => entry !== day);
                  set("businessDays", [...next].sort((a, b) => a - b).join(","));
                }}
              />
              {weekdayName(day, locale)}
            </label>
          ))}
        </fieldset>
        <label>
          {t("configBusinessStart")}
          <input
            type="time"
            value={draft.businessStart}
            disabled={!canWrite || !businessOn}
            onChange={(event) => {
              set("businessStart", event.target.value);
            }}
          />
        </label>
        <label>
          {t("configBusinessEnd")}
          <input
            type="time"
            value={draft.businessEnd}
            disabled={!canWrite || !businessOn}
            onChange={(event) => {
              set("businessEnd", event.target.value);
            }}
          />
        </label>
        <label>
          {t("configBusinessTimeZone")}
          <input
            list={`${fieldId}-zones`}
            value={draft.businessTimeZone ?? ""}
            disabled={!canWrite || !businessOn}
            maxLength={64}
            onChange={(event) => {
              set("businessTimeZone", event.target.value === "" ? null : event.target.value);
            }}
          />
          <datalist id={`${fieldId}-zones`}>
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </label>
        <label>
          {t("configHolidays")}
          <textarea
            rows={3}
            value={draft.holidays}
            disabled={!canWrite}
            maxLength={2400}
            placeholder="2026-12-25"
            onChange={(event) => {
              set("holidays", event.target.value);
            }}
          />
        </label>
        <label className="configuration-check">
          <input
            type="checkbox"
            checked={draft.pauseOutgoing}
            disabled={!canWrite}
            onChange={(event) => {
              set("pauseOutgoing", event.target.checked);
            }}
          />
          {t("configPause")}
        </label>
      </div>
      {canWrite && (
        <div className="configuration-actions">
          <button
            type="button"
            className="secondary"
            disabled={!dirty || !valid}
            onClick={() => {
              void write(true);
            }}
          >
            {t("configCheck")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!dirty || !valid}
            onClick={() => {
              void write(false);
            }}
          >
            {t("configSave")}
          </button>
        </div>
      )}
      {canWrite && dirty && !valid && (
        <p className="error" role="status">
          {t("configInvalid")}
        </p>
      )}
      {checked && (
        <ul className="configuration-diff" aria-label={t("configDiff")}>
          {checked.map((entry) => (
            <li key={entry.pointer}>
              {entry.pointer.slice(1)}: {show(entry.from)} → {show(entry.to)}
            </li>
          ))}
          {checked.length === 0 && <li>{t("configUnchanged")}</li>}
        </ul>
      )}
      {message && (
        <p
          className={message === "error" || message === "configStale" ? "error" : "muted"}
          role="status"
        >
          {t(message)}
        </p>
      )}
      {changes.length > 0 && (
        <>
          <h4>{t("configPending")}</h4>
          <ul className="configuration-changes">
            {changes.map((change) => (
              <li key={change.id}>
                <span>
                  {change.diff
                    .map(
                      (entry) =>
                        `${entry.pointer.slice(1)}: ${show(entry.from)} → ${show(entry.to)}`,
                    )
                    .join("; ")}
                </span>
                <span className="muted">
                  {t(change.proposerKind === "agent" ? "configByAgent" : "configByPerson")}
                </span>
                {canApprove && (
                  <span className="configuration-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        void decide(change.id, "approve");
                      }}
                    >
                      {t("configApprove")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        void decide(change.id, "reject");
                      }}
                    >
                      {t("configReject")}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
