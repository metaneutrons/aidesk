"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Actions, Disclosure, Group, Row, Switch, Unit } from "./form";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { z } from "zod";
import { parseDays } from "../domain/business-hours";
import {
  retentionCounts,
  retentionKinds,
  retentionKey,
  retentionOf,
  retentionSuggestions,
  tightens,
  type RetentionKind,
} from "../domain/retention";
import { configDocument, type ConfigDocument } from "../domain/configuration";
import {
  modesOf,
  ruleKeys,
  type NotificationKind,
  type RecipientMode,
} from "../domain/notifications";
// The rules that say which events tell operators, with the text of each and of each mode.
const notificationRows = [
  { kind: "new_ticket", label: "configNotifyNewTicket" },
  { kind: "assignment", label: "configNotifyAssignment" },
  { kind: "mention", label: "configNotifyMention" },
  { kind: "overdue", label: "configNotifyOverdue" },
  { kind: "draft", label: "configNotifyDraft" },
].map((row) => ({
  ...row,
  kind: row.kind as NotificationKind,
  key: ruleKeys[row.kind as NotificationKind],
}));
function modeLabel(kind: NotificationKind, mode: RecipientMode): string {
  if (mode === "off") return "configNotifyOff";
  if (mode === "members") return "configNotifyMembers";
  return kind === "mention"
    ? "configNotifyMentioned"
    : kind === "assignment"
      ? "configNotifyAssigneeOnly"
      : "configNotifyAssignee";
}
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
// The configuration key of the period of a kind, typed.
const retentionConfigKey = (kind: RetentionKind) =>
  retentionKey(kind) as
    | "retentionTicketsDays"
    | "retentionAttachmentsDays"
    | "retentionOriginalsDays"
    | "retentionTranslationsDays"
    | "retentionAiRunsDays";
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
  const [dryRun, setDryRun] = useState<{
    for: string;
    due: z.infer<typeof retentionCounts>;
  } | null>(null);
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
  const periods = retentionOf(draft);
  const periodsKey = JSON.stringify(periods);
  // A period that is set or made shorter removes more than before, and its dry run has to be seen first.
  const tightened = tightens(retentionOf(saved), periods);
  const needsDryRun = tightened.length > 0 && dryRun?.for !== periodsKey;
  async function showDryRun() {
    const response = await fetch(`/api/v1/projects/${projectId}/retention/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(periods),
    }).catch(() => null);
    const parsed = response?.ok
      ? z.object({ due: retentionCounts }).safeParse(await response.json())
      : null;
    if (parsed?.success) setDryRun({ for: periodsKey, due: parsed.data.due });
    else setMessage("error");
  }
  const valid = configDocument.safeParse(draft).success;
  const businessOn = draft.businessDays !== null;
  const businessDays = parseDays(draft.businessDays ?? "") ?? [];
  const zones: string[] = Intl.supportedValuesOf("timeZone");
  const clamp = (value: string, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.trunc(Number(value)) || min));
  const optional = (value: string, min: number, max: number) =>
    value === "" ? null : clamp(value, min, max);
  const hours = t("unitHours");
  const days = t("unitDays");
  const weekdayLabel = `${fieldId}-weekdays`;
  return (
    <section className="configuration" aria-labelledby={`${fieldId}-title`}>
      <h3 id={`${fieldId}-title`}>{t("configTitle", { project: name })}</h3>
      <Group>
        <Row label={t("configName")}>
          {(props) => (
            <input
              {...props}
              value={draft.name}
              disabled={!canWrite}
              maxLength={100}
              onChange={(event) => {
                set("name", event.target.value);
              }}
            />
          )}
        </Row>
        <Row label={t("configColor")}>
          {(props) => (
            <input
              {...props}
              type="color"
              value={draft.color}
              disabled={!canWrite}
              onChange={(event) => {
                set("color", event.target.value);
              }}
            />
          )}
        </Row>
        <Row label={t("configLanguage")}>
          {(props) => (
            <select
              {...props}
              value={draft.defaultLanguage}
              disabled={!canWrite}
              onChange={(event) => {
                set("defaultLanguage", event.target.value === "de" ? "de" : "en");
              }}
            >
              <option value="en">English</option>
              <option value="de">Deutsch</option>
            </select>
          )}
        </Row>
        <Row label={t("configOutgoing")}>
          {(props) => (
            <select
              {...props}
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
          )}
        </Row>
        <Switch
          label={t("configPause")}
          checked={draft.pauseOutgoing}
          disabled={!canWrite}
          onChange={(checked) => {
            set("pauseOutgoing", checked);
          }}
        />
      </Group>
      <Group title={t("configGroupCustomers")}>
        <Switch
          label={t("configAcknowledgements")}
          hint={t("acknowledgementHint")}
          checked={draft.acknowledgements}
          disabled={!canWrite}
          onChange={(checked) => {
            set("acknowledgements", checked);
          }}
        />
        <Switch
          label={t("configPortalLinks")}
          hint={t("portalLinksHint")}
          checked={draft.portalLinks}
          disabled={!canWrite}
          onChange={(checked) => {
            set("portalLinks", checked);
          }}
        />
        <Row label={t("configReopenMode")}>
          {(props) => (
            <select
              {...props}
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
          )}
        </Row>
        <Row label={t("configReopenDays")}>
          {(props) => (
            <Unit unit={days}>
              <input
                {...props}
                type="number"
                min={1}
                max={365}
                value={draft.reopenDays}
                disabled={!canWrite || draft.reopenMode !== "reopen"}
                onChange={(event) => {
                  set("reopenDays", clamp(event.target.value, 1, 365));
                }}
              />
            </Unit>
          )}
        </Row>
        <Row label={t("configAutoResolve")}>
          {(props) => (
            <Unit unit={days}>
              <input
                {...props}
                type="number"
                min={1}
                max={365}
                value={draft.autoResolveDays ?? ""}
                placeholder={t("configAutoResolveOff")}
                disabled={!canWrite}
                onChange={(event) => {
                  set("autoResolveDays", optional(event.target.value, 1, 365));
                  if (event.target.value === "") set("autoResolveReminderDays", null);
                }}
              />
            </Unit>
          )}
        </Row>
        <Row label={t("configAutoResolveReminder")}>
          {(props) => (
            <Unit unit={days}>
              <input
                {...props}
                type="number"
                min={1}
                max={364}
                value={draft.autoResolveReminderDays ?? ""}
                placeholder={t("configAutoResolveOff")}
                disabled={!canWrite || draft.autoResolveDays === null}
                onChange={(event) => {
                  set(
                    "autoResolveReminderDays",
                    optional(event.target.value, 1, (draft.autoResolveDays ?? 2) - 1),
                  );
                }}
              />
            </Unit>
          )}
        </Row>
        <Row label={t("configJunkSensitivity")}>
          {(props) => (
            <select
              {...props}
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
          )}
        </Row>
      </Group>
      <Group title={t("configGroupTimes")}>
        <Row label={t("configWarn")}>
          {(props) => (
            <Unit unit={hours}>
              <input
                {...props}
                type="number"
                min={1}
                max={720}
                value={draft.warnHours}
                disabled={!canWrite}
                onChange={(event) => {
                  set("warnHours", clamp(event.target.value, 1, 720));
                }}
              />
            </Unit>
          )}
        </Row>
        <Row label={t("configOverdue")}>
          {(props) => (
            <Unit unit={hours}>
              <input
                {...props}
                type="number"
                min={1}
                max={720}
                value={draft.overdueHours}
                disabled={!canWrite}
                onChange={(event) => {
                  set("overdueHours", clamp(event.target.value, 1, 720));
                }}
              />
            </Unit>
          )}
        </Row>
        <Disclosure title={t("configPriorityGroup")} hint={t("configPriorityGroupHint")}>
          {priorityFields.map(([key, label]) => (
            <Row key={key} label={t(label)}>
              {(props) => (
                <Unit unit={hours}>
                  <input
                    {...props}
                    type="number"
                    min={1}
                    max={720}
                    value={draft[key] ?? ""}
                    placeholder="–"
                    disabled={!canWrite}
                    onChange={(event) => {
                      set(key, optional(event.target.value, 1, 720));
                    }}
                  />
                </Unit>
              )}
            </Row>
          ))}
        </Disclosure>
      </Group>
      <Group title={t("configGroupHours")}>
        <Switch
          label={t("configBusinessHours")}
          checked={businessOn}
          disabled={!canWrite}
          onChange={(checked) => {
            setDraft({
              ...draft,
              businessDays: checked ? "1,2,3,4,5" : null,
              businessTimeZone: checked
                ? (draft.businessTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
                : draft.businessTimeZone,
            });
            edited.current = true;
            setChecked(null);
          }}
        />
        <div className="row stacked">
          <div className="row-label">
            <span id={weekdayLabel}>{t("configBusinessDays")}</span>
          </div>
          <div className="row-control weekdays" role="group" aria-labelledby={weekdayLabel}>
            {weekdays.map((day) => (
              <label key={day} className="chip">
                <input
                  type="checkbox"
                  checked={businessDays.includes(day)}
                  disabled={!canWrite || !businessOn}
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
          </div>
        </div>
        <Row label={t("configBusinessStart")}>
          {(props) => (
            <input
              {...props}
              type="time"
              value={draft.businessStart}
              disabled={!canWrite || !businessOn}
              onChange={(event) => {
                set("businessStart", event.target.value);
              }}
            />
          )}
        </Row>
        <Row label={t("configBusinessEnd")}>
          {(props) => (
            <input
              {...props}
              type="time"
              value={draft.businessEnd}
              disabled={!canWrite || !businessOn}
              onChange={(event) => {
                set("businessEnd", event.target.value);
              }}
            />
          )}
        </Row>
        <Row label={t("configBusinessTimeZone")}>
          {(props) => (
            <>
              <input
                {...props}
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
            </>
          )}
        </Row>
        <Row label={t("configHolidays")} stacked>
          {(props) => (
            <textarea
              {...props}
              rows={3}
              value={draft.holidays}
              disabled={!canWrite}
              maxLength={2400}
              placeholder="2026-12-25"
              onChange={(event) => {
                set("holidays", event.target.value);
              }}
            />
          )}
        </Row>
      </Group>
      <Group title={t("configNotifyTitle")}>
        {notificationRows.map((row) => (
          <Row key={row.key} label={t(row.label)}>
            {(props) => (
              <select
                {...props}
                value={draft[row.key]}
                disabled={!canWrite}
                onChange={(event) => {
                  set(row.key, event.target.value as (typeof draft)[typeof row.key]);
                }}
              >
                {modesOf[row.kind].map((mode) => (
                  <option key={mode} value={mode}>
                    {t(modeLabel(row.kind, mode))}
                  </option>
                ))}
              </select>
            )}
          </Row>
        ))}
      </Group>
      <Group>
        <Row label={t("configCategories")} stacked>
          {(props) => (
            <textarea
              {...props}
              rows={3}
              value={draft.categories}
              disabled={!canWrite}
              maxLength={2050}
              onChange={(event) => {
                set("categories", event.target.value);
              }}
            />
          )}
        </Row>
      </Group>
      <Group note={t("retentionHint")}>
        <Disclosure title={t("retentionTitle")}>
          {retentionKinds.map((kind) => (
            <Row
              key={kind}
              label={t(`retentionKind_${kind}`)}
              hint={t("retentionSuggestion", { days: retentionSuggestions[kind] })}
            >
              {(props) => (
                <Unit unit={days}>
                  <input
                    {...props}
                    type="number"
                    min={1}
                    max={3650}
                    value={draft[retentionConfigKey(kind)] ?? ""}
                    placeholder={t("retentionForever")}
                    disabled={!canWrite}
                    onChange={(event) => {
                      set(retentionConfigKey(kind), optional(event.target.value, 1, 3650));
                    }}
                  />
                </Unit>
              )}
            </Row>
          ))}
          <div className="row">
            <span />
            <div className="row-control">
              <button
                type="button"
                className="secondary"
                disabled={!canWrite}
                onClick={() => void showDryRun()}
              >
                {t("retentionDryRun")}
              </button>
            </div>
          </div>
          {dryRun?.for === periodsKey && (
            <ul className="row stacked" aria-label={t("retentionDryRunResult")}>
              {retentionKinds
                .filter((kind) => periods[kind] !== null)
                .map((kind) => (
                  <li key={kind}>
                    {t(`retentionKind_${kind}`)}:{" "}
                    {t("retentionWouldRemove", { count: dryRun.due[kind] })}
                  </li>
                ))}
            </ul>
          )}
        </Disclosure>
      </Group>
      {needsDryRun && (
        <p className="muted" role="status">
          {t("retentionNeedsDryRun")}
        </p>
      )}
      {tightened.length > 0 && !canApprove && (
        <p className="muted" role="status">
          {t("retentionNeedsApproval")}
        </p>
      )}
      <Group>
        <Row label={t("configPolicy")}>
          {(props) => (
            <select
              {...props}
              value={draft.approvalPolicy}
              disabled={!canApprove}
              onChange={(event) => {
                set("approvalPolicy", event.target.value === "direct" ? "direct" : "review");
              }}
            >
              <option value="review">{t("configPolicyReview")}</option>
              <option value="direct">{t("configPolicyDirect")}</option>
            </select>
          )}
        </Row>
      </Group>
      {canWrite && (
        <Actions>
          <button
            type="button"
            className="secondary"
            disabled={!dirty || !valid || needsDryRun}
            onClick={() => {
              void write(true);
            }}
          >
            {t("configCheck")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!dirty || !valid || needsDryRun}
            onClick={() => {
              void write(false);
            }}
          >
            {t("configSave")}
          </button>
        </Actions>
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
