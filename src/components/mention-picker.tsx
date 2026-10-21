"use client";
import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
// Names the people that an internal note is for. The choice adds the name to the text and the person to the list that
// is sent with the note; a person on the list is told of the note when the rules of the project say so.
const people = z.object({ users: z.array(z.object({ id: z.string(), name: z.string() })) });
export interface Mention {
  id: string;
  name: string;
}
export function MentionPicker({
  ticketId,
  selfId,
  chosen,
  disabled,
  onAdd,
  onRemove,
}: {
  ticketId: string;
  selfId: string;
  chosen: Mention[];
  disabled: boolean;
  onAdd: (person: Mention) => void;
  onRemove: (id: string) => void;
}) {
  const t = useTranslations();
  const labelId = useId();
  const [users, setUsers] = useState<Mention[]>([]);
  // The answer for a ticket that is no longer shown is dropped.
  useEffect(() => {
    const run = { current: true };
    void (async () => {
      const response = await fetch(`/api/v1/tickets/${ticketId}/mentionable`).catch(() => null);
      const parsed = response?.ok ? people.safeParse(await response.json()) : null;
      if (parsed?.success && run.current) setUsers(parsed.data.users);
    })();
    return () => {
      run.current = false;
    };
  }, [ticketId]);
  const free = users.filter(
    (person) => person.id !== selfId && !chosen.some((entry) => entry.id === person.id),
  );
  if (users.length === 0) return null;
  return (
    <div className="mention-picker">
      <label htmlFor={labelId}>{t("mentionLabel")}</label>
      <select
        id={labelId}
        value=""
        disabled={disabled || free.length === 0 || chosen.length >= 10}
        onChange={(event) => {
          const person = free.find((entry) => entry.id === event.target.value);
          if (person) onAdd(person);
        }}
      >
        <option value="">{t("mentionChoose")}</option>
        {free.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
      {chosen.length > 0 && (
        <ul className="mention-list" aria-label={t("mentionList")}>
          {chosen.map((person) => (
            <li key={person.id}>
              @{person.name}
              <button
                type="button"
                className="icon-button"
                aria-label={t("mentionRemove", { name: person.name })}
                disabled={disabled}
                onClick={() => {
                  onRemove(person.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
