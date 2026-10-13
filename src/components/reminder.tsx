"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { BellRing } from "lucide-react";
// A time at which the team wants to see this ticket again. Setting or clearing
// it does not change the conversation. The input uses the browser's own time
// zone; the server stores the instant.
function localValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}
export function Reminder({
  ticketId,
  remindAt,
  now,
  locale,
  onChanged,
}: {
  ticketId: string;
  remindAt: string | null;
  now: number;
  locale: string;
  onChanged: () => void;
}) {
  const t = useTranslations();
  const [value, setValue] = useState(localValue(remindAt));
  const [failed, setFailed] = useState(false);
  async function save(next: string | null) {
    setFailed(false);
    const response = await fetch(`/api/v1/tickets/${ticketId}/reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remindAt: next }),
    }).catch(() => null);
    if (!response?.ok) {
      setFailed(true);
      return;
    }
    if (next === null) setValue("");
    onChanged();
  }
  // A preset a day or a week ahead at 9:00 local time.
  function preset(days: number): string {
    const date = new Date(now + days * 86_400_000);
    date.setHours(9, 0, 0, 0);
    return date.toISOString();
  }
  const due = remindAt !== null && new Date(remindAt).getTime() <= now;
  return (
    <div className="reminder">
      <BellRing size={16} aria-hidden="true" />
      {remindAt && (
        <span className={due ? "attention" : "muted"}>
          {t(due ? "reminderDue" : "reminderAt", {
            date: new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(remindAt)),
          })}
        </span>
      )}
      <label>
        <span className="visually-hidden">{t("reminderSet")}</span>
        <input
          type="datetime-local"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </label>
      <button
        type="button"
        className="secondary"
        disabled={!value}
        onClick={() => {
          void save(new Date(value).toISOString());
        }}
      >
        {t("reminderSet")}
      </button>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          void save(preset(1));
        }}
      >
        {t("reminderTomorrow")}
      </button>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          void save(preset(7));
        }}
      >
        {t("reminderNextWeek")}
      </button>
      {remindAt && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void save(null);
          }}
        >
          {due ? t("reminderDone") : t("reminderClear")}
        </button>
      )}
      {failed && (
        <small className="error" role="alert">
          {t("error")}
        </small>
      )}
    </div>
  );
}
