"use client";
import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { Group } from "./form";
import { notificationKinds, preferenceOut } from "../domain/notifications";
// For each kind of notification, whether it reaches the signed-in operator in the desk and by mail. A project decides
// first which events notify at all (see the configuration of the project); this is the choice of each person.
type Preferences = z.infer<typeof preferenceOut>["preferences"];
export function NotificationPreferences() {
  const t = useTranslations();
  const titleId = useId();
  const [rows, setRows] = useState<Preferences | null>(null);
  const [message, setMessage] = useState<"saved" | "error" | null>(null);
  useEffect(() => {
    const run = { current: true };
    void (async () => {
      const response = await fetch("/api/v1/me/notification-preferences").catch(() => null);
      const parsed = response?.ok ? preferenceOut.safeParse(await response.json()) : null;
      if (parsed?.success && run.current) setRows(parsed.data.preferences);
    })();
    return () => {
      run.current = false;
    };
  }, []);
  if (rows === null) return null;
  async function change(
    kind: (typeof notificationKinds)[number],
    channel: "desk" | "mail",
    on: boolean,
  ) {
    const current = rows?.find((row) => row.kind === kind);
    if (!current) return;
    setMessage(null);
    // The box shows the choice at once; the answer of the server replaces it, or puts the earlier one back.
    const before = rows;
    setRows(
      (shown) => shown?.map((row) => (row.kind === kind ? { ...row, [channel]: on } : row)) ?? null,
    );
    const response = await fetch("/api/v1/me/notification-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferences: [{ ...current, [channel]: on }] }),
    }).catch(() => null);
    const parsed = response?.ok ? preferenceOut.safeParse(await response.json()) : null;
    if (parsed?.success) {
      setRows(parsed.data.preferences);
      setMessage("saved");
    } else {
      setRows(before);
      setMessage("error");
    }
  }
  return (
    <section className="connections notification-preferences" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("notificationPrefsTitle")}</h3>
      <p className="muted">{t("notificationPrefsHint")}</p>
      <Group>
        {rows.map((row) => (
          <div className="row" key={row.kind}>
            <div className="row-label">
              <span>{t(`notificationKind_${row.kind}`)}</span>
            </div>
            <div className="row-control">
              {(["desk", "mail"] as const).map((channel) => (
                <label key={channel} className="inline-switch">
                  {t(channel === "desk" ? "notificationPrefsDesk" : "notificationPrefsMail")}
                  <input
                    type="checkbox"
                    className="switch"
                    checked={row[channel]}
                    aria-label={`${t(`notificationKind_${row.kind}`)}: ${t(channel === "desk" ? "notificationPrefsDesk" : "notificationPrefsMail")}`}
                    onChange={(event) => {
                      void change(row.kind, channel, event.target.checked);
                    }}
                  />
                </label>
              ))}
            </div>
          </div>
        ))}
      </Group>
      {message && (
        <p className={message === "error" ? "error" : "muted"} role="status">
          {t(message === "saved" ? "notificationPrefsSaved" : "notificationPrefsError")}
        </p>
      )}
    </section>
  );
}
