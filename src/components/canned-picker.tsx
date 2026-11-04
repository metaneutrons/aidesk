"use client";
import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { cannedForTicketOut } from "../domain/canned";
// The canned replies of the project of a ticket, filled in for the ticket and the person who writes. Choosing one
// hands its text to the composer, which puts it into the field and can take it back.
const listSchema = z.array(cannedForTicketOut);
type Entry = z.infer<typeof cannedForTicketOut>;
export function CannedPicker({
  ticketId,
  disabled,
  onPick,
}: {
  ticketId: string;
  disabled: boolean;
  onPick: (text: string) => void;
}) {
  const t = useTranslations();
  const id = useId();
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    const run = { current: true };
    void (async () => {
      const response = await fetch(`/api/v1/tickets/${ticketId}/canned-replies`).catch(() => null);
      const parsed = response?.ok ? listSchema.safeParse(await response.json()) : null;
      if (run.current) setEntries(parsed?.success ? parsed.data : []);
    })();
    return () => {
      run.current = false;
    };
  }, [ticketId]);
  if (entries.length === 0) return null;
  return (
    <select
      id={id}
      aria-label={t("cannedPick")}
      disabled={disabled}
      value=""
      onChange={(event) => {
        const chosen = entries.find((entry) => entry.id === event.target.value);
        if (chosen) onPick(chosen.text);
      }}
    >
      <option value="">{t("cannedPick")}</option>
      {entries.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.name} ({entry.language})
        </option>
      ))}
    </select>
  );
}
