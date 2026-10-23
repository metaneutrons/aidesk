"use client";
import { useCallback, useEffect, useId, useState, type SyntheticEvent } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { useZone } from "./time-zone";
// The webhooks of one project: where events are sent, what happened to the last
// delivery, a test event and disabling. A channel of a messenger is added here,
// with the subject of the ticket off unless it is switched on, which needs the
// right to approve. Defining a webhook of the format `aidesk`, with its signing
// secret, is done through the API; the page never shows a secret or the address
// of a channel.
const channelFormats = [
  "teams",
  "slack",
  "discord",
  "mattermost",
  "rocketchat",
  "apprise",
] as const;
const channelEvents = [
  "ticket.created",
  "ticket.assigned",
  "ticket.overdue",
  "draft.created",
  "ticket.status_changed",
] as const;
const defaultEvents: readonly string[] = [
  "ticket.created",
  "ticket.assigned",
  "ticket.overdue",
  "draft.created",
];
const problems = z.object({
  issues: z.array(z.object({ pointer: z.string(), message: z.string() })).optional(),
});
const hookSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  format: z.enum(["aidesk", ...channelFormats]),
  withSubject: z.boolean(),
  status: z.enum(["active", "disabled"]),
  version: z.number(),
  lastDelivery: z
    .object({
      at: z.string(),
      event: z.string(),
      outcome: z.enum(["succeeded", "retry", "failed", "skipped"]),
      responseStatus: z.number().nullable(),
      code: z.string().nullable(),
    })
    .nullable(),
});
type Hook = z.infer<typeof hookSchema>;
export function Webhooks({
  projectId,
  name,
  locale,
}: {
  projectId: string;
  name: string;
  locale: string;
}) {
  const t = useTranslations();
  const zone = useZone();
  const titleId = useId();
  const [rows, setRows] = useState<Hook[] | null>(null);
  const [message, setMessage] = useState<
    "error" | "webhookProposed" | "webhookPinged" | "channelCreated" | null
  >(null);
  const [adding, setAdding] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [format, setFormat] = useState<(typeof channelFormats)[number]>(channelFormats[0]);
  const [address, setAddress] = useState("");
  const [events, setEvents] = useState<readonly string[]>(defaultEvents);
  const [withSubject, setWithSubject] = useState(false);
  const [failed, setFailed] = useState<string[] | null>(null);
  const [working, setWorking] = useState(false);
  // The switch of the subject follows the server: a change that only proposes leaves it as it was.
  const [switching, setSwitching] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch(`/api/v1/projects/${projectId}/webhooks`).catch(() => null);
    const parsed = response?.ok ? z.array(hookSchema).safeParse(await response.json()) : null;
    if (parsed?.success) setRows(parsed.data);
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function run(row: Hook, action: "ping" | "disable") {
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${projectId}/webhooks/${row.id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "disable" ? { expectedVersion: row.version } : {}),
    }).catch(() => null);
    if (!response?.ok) setMessage("error");
    else
      setMessage(
        action === "ping" ? "webhookPinged" : response.status === 202 ? "webhookProposed" : null,
      );
    await load();
  }
  async function addChannel(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setWorking(true);
    setFailed(null);
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${projectId}/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: channelName, url: address, format, events, withSubject }),
    }).catch(() => null);
    setWorking(false);
    if (response?.ok) {
      setMessage(response.status === 202 ? "webhookProposed" : "channelCreated");
      setAdding(false);
      setChannelName("");
      setAddress("");
      setEvents(defaultEvents);
      setWithSubject(false);
      await load();
      return;
    }
    const body = problems.safeParse(await response?.json().catch(() => null));
    setFailed(
      body.success
        ? (body.data.issues ?? []).map((issue) => `${issue.pointer}: ${issue.message}`)
        : [],
    );
  }
  async function switchSubject(row: Hook, on: boolean): Promise<void> {
    setMessage(null);
    setSwitching(true);
    const response = await fetch(`/api/v1/projects/${projectId}/webhooks/${row.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: row.version, withSubject: on }),
    }).catch(() => null);
    if (!response?.ok) setMessage("error");
    else if (response.status === 202) setMessage("webhookProposed");
    await load();
    setSwitching(false);
  }
  if (rows === null) return null;
  return (
    <section className="connections" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("webhooksTitle", { project: name })}</h3>
      <p className="muted">{t("webhooksHint")}</p>
      {rows.length === 0 ? (
        <p className="muted">{t("webhooksNone")}</p>
      ) : (
        <ul className="connection-list">
          {rows.map((row) => (
            <li key={row.id}>
              <span>
                <strong>{row.name}</strong>{" "}
                <span className="muted">
                  {t(`webhookFormat_${row.format}`)} · {row.url}
                </span>
                <br />
                <small className="muted">{row.events.join(", ")}</small>
                {row.format !== "aidesk" && (
                  <label className="configuration-check">
                    <input
                      type="checkbox"
                      checked={row.withSubject}
                      disabled={switching}
                      onChange={(event) => {
                        void switchSubject(row, event.target.checked);
                      }}
                    />
                    {t("channelSubjectSwitch", { name: row.name })}
                  </label>
                )}
              </span>
              <span className={row.lastDelivery?.outcome === "failed" ? "attention" : "muted"}>
                {row.status === "disabled"
                  ? t("webhookDisabled")
                  : row.lastDelivery
                    ? t(`webhookDelivery_${row.lastDelivery.outcome}`, {
                        date: new Intl.DateTimeFormat(locale, {
                          ...zone,
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(row.lastDelivery.at)),
                        code: row.lastDelivery.code ?? "",
                      })
                    : t("webhookNoDelivery")}
              </span>
              <span className="connection-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={row.status === "disabled"}
                  onClick={() => {
                    void run(row, "ping");
                  }}
                >
                  {t("webhookPing", { name: row.name })}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={row.status === "disabled"}
                  onClick={() => {
                    void run(row, "disable");
                  }}
                >
                  {t("webhookDisable", { name: row.name })}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <form
          className="connection-form"
          onSubmit={(event) => {
            void addChannel(event);
          }}
        >
          <h4>{t("channelTitle")}</h4>
          <p className="muted">{t("channelHint")}</p>
          <label>
            {t("channelName")}
            <input
              required
              maxLength={100}
              value={channelName}
              onChange={(event) => {
                setChannelName(event.target.value);
              }}
            />
          </label>
          <label>
            {t("channelFormat")}
            <select
              value={format}
              onChange={(event) => {
                setFormat(event.target.value as (typeof channelFormats)[number]);
              }}
            >
              {channelFormats.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`webhookFormat_${entry}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("channelAddress")}
            <input
              required
              type="password"
              autoComplete="off"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
              }}
            />
          </label>
          <fieldset>
            <legend>{t("channelEvents")}</legend>
            {channelEvents.map((entry) => (
              <label key={entry} className="configuration-check">
                <input
                  type="checkbox"
                  checked={events.includes(entry)}
                  onChange={(event) => {
                    setEvents(
                      event.target.checked
                        ? [...events, entry]
                        : events.filter((value) => value !== entry),
                    );
                  }}
                />
                {t(`channelEvent_${entry.replace(".", "_")}`)}
              </label>
            ))}
          </fieldset>
          <label className="configuration-check">
            <input
              type="checkbox"
              checked={withSubject}
              onChange={(event) => {
                setWithSubject(event.target.checked);
              }}
            />
            {t("channelSubject")}
          </label>
          <small className="muted">{t("channelSubjectHint")}</small>
          {failed && (
            <div className="error" role="alert">
              {t("channelError")}
              {failed.length > 0 && (
                <ul>
                  {failed.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="configuration-actions">
            <button
              type="submit"
              className="primary"
              disabled={working || !channelName.trim() || !address.trim() || events.length === 0}
            >
              {t("channelCreate")}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setAdding(false);
                setFailed(null);
              }}
            >
              {t("channelCancel")}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setAdding(true);
          }}
        >
          {t("channelAdd")}
        </button>
      )}
      {message && (
        <p className={message === "error" ? "error" : "muted"} role="status">
          {t(message)}
        </p>
      )}
    </section>
  );
}
