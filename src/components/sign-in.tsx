"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { sessionList, signInOut } from "../domain/sign-in";
import { useZone } from "./time-zone";
// How the signed-in operator can sign in, and the sessions that are open: one can be ended, or all the others. The
// session that shows this page is marked and is left by signing out.
type Sessions = z.infer<typeof sessionList>["sessions"];
export function SignIn({ locale }: { locale: string }) {
  const t = useTranslations();
  const zone = useZone();
  const titleId = useId();
  const [methods, setMethods] = useState<z.infer<typeof signInOut> | null>(null);
  const [sessions, setSessions] = useState<Sessions | null>(null);
  const [message, setMessage] = useState<"ended" | "error" | null>(null);
  const when = new Intl.DateTimeFormat(locale, {
    ...zone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const load = useCallback(async () => {
    const [signIn, list] = await Promise.all([
      fetch("/api/v1/me/sign-in").catch(() => null),
      fetch("/api/v1/me/sessions").catch(() => null),
    ]);
    const parsedMethods = signIn?.ok ? signInOut.safeParse(await signIn.json()) : null;
    const parsedList = list?.ok ? sessionList.safeParse(await list.json()) : null;
    if (parsedMethods?.success) setMethods(parsedMethods.data);
    if (parsedList?.success) setSessions(parsedList.data.sessions);
  }, []);
  // In development React runs the effect twice; the answers are the same, so the later one may replace the earlier.
  useEffect(() => {
    void load();
  }, [load]);
  async function end(path: string): Promise<void> {
    setMessage(null);
    const response = await fetch(`/api/v1/me/sessions/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    setMessage(response?.ok ? "ended" : "error");
    await load();
  }
  if (methods === null || sessions === null) return null;
  const others = sessions.filter((entry) => !entry.current);
  const how = [
    methods.providers.length > 0
      ? t("signInProviders", { providers: methods.providers.join(", ") })
      : null,
    methods.password ? t("signInPassword") : null,
    methods.codes ? t("signInCodes") : null,
    methods.passkeys > 0 ? t("signInPasskeys", { count: methods.passkeys }) : null,
  ].filter((entry): entry is string => entry !== null);
  return (
    <section className="connections sign-in" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("signInTitle")}</h3>
      <p className="muted">{t("signInHint")}</p>
      {how.length === 0 ? (
        <p className="muted">{t("signInNone")}</p>
      ) : (
        <ul className="sign-in-methods" aria-label={t("signInMethods")}>
          {how.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      )}
      <h4>{t("sessionsTitle")}</h4>
      <ul className="session-list" aria-label={t("sessionsTitle")}>
        {sessions.map((entry) => (
          <li key={entry.id} className={entry.current ? "current" : undefined}>
            <strong>{entry.current ? t("sessionCurrent") : t("sessionOther")}</strong>
            <span>{entry.userAgent ?? t("sessionUnknownDevice")}</span>
            <small className="muted">
              {t("sessionStarted", { date: when.format(new Date(entry.createdAt)) })}
              {entry.ipAddress ? ` · ${entry.ipAddress}` : ""} ·{" "}
              {t("sessionEnds", { date: when.format(new Date(entry.expiresAt)) })}
            </small>
            {!entry.current && (
              <button
                type="button"
                className="secondary"
                aria-label={`${t("sessionEnd")}: ${entry.userAgent ?? entry.id}`}
                onClick={() => {
                  void end(`${entry.id}/end`);
                }}
              >
                {t("sessionEnd")}
              </button>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="secondary"
        disabled={others.length === 0}
        onClick={() => {
          void end("end-others");
        }}
      >
        {t("sessionsEndOthers")}
      </button>
      {message && (
        <p className={message === "error" ? "error" : "muted"} role="status">
          {t(message === "ended" ? "sessionsEnded" : "sessionsError")}
        </p>
      )}
    </section>
  );
}
