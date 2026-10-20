"use client";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { priorities, priorityOf, type Priority } from "../domain/triage";
// The priority and the category of a ticket, set from the ticket header. A category that is no longer on the list of
// the project stays shown and selected for the tickets that have it.
export const priorityKey = (priority: Priority) =>
  `priority${priority[0]?.toUpperCase() ?? ""}${priority.slice(1)}`;
export function Triage({
  ticketId,
  priority,
  category,
  categories,
  onChanged,
}: {
  ticketId: string;
  priority: string;
  category: string | null;
  categories: readonly string[];
  onChanged: () => void;
}) {
  const t = useTranslations();
  const id = useId();
  const [failed, setFailed] = useState(false);
  const listed = category !== null && !categories.includes(category) ? [category] : [];
  async function save(values: { priority?: Priority; category?: string | null }) {
    setFailed(false);
    const response = await fetch(`/api/v1/tickets/${ticketId}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    }).catch(() => null);
    if (!response?.ok) {
      setFailed(true);
      return;
    }
    onChanged();
  }
  return (
    <div className="triage" role="group" aria-label={t("triageGroup")}>
      <label htmlFor={`${id}-priority`}>{t("priorityLabel")}</label>
      <select
        id={`${id}-priority`}
        value={priorityOf(priority)}
        onChange={(event) => {
          void save({ priority: priorityOf(event.target.value) });
        }}
      >
        {priorities.map((entry) => (
          <option key={entry} value={entry}>
            {t(priorityKey(entry))}
          </option>
        ))}
      </select>
      {(categories.length > 0 || category !== null) && (
        <>
          <label htmlFor={`${id}-category`}>{t("categoryLabel")}</label>
          <select
            id={`${id}-category`}
            value={category ?? ""}
            onChange={(event) => {
              void save({ category: event.target.value === "" ? null : event.target.value });
            }}
          >
            <option value="">{t("categoryNone")}</option>
            {[...listed, ...categories].map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </>
      )}
      {failed && (
        <span className="error" role="alert">
          {t("error")}
        </span>
      )}
    </div>
  );
}
