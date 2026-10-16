"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { locales } from "../domain/locale";
import { translationStatuses } from "../domain/translation";
// The machine translations of one message, next to the source: ask for one into a language, see
// its state, and remove them. A translation never replaces the message, is marked as made by a
// machine with the model and the revision of the profile, and says why there is none when it
// failed. A message is translated into a language that it is not written in.
const itemSchema = z.object({
  id: z.string(),
  language: z.string(),
  current: z.boolean(),
  status: z.enum(translationStatuses),
  model: z.string().nullable(),
  profileRevision: z.number().nullable(),
  error: z.string().nullable(),
  html: z.string().nullable(),
});
type Item = z.infer<typeof itemSchema>;
const languageName = (locale: string, code: string) =>
  new Intl.DisplayNames(locale, { type: "language" }).of(code) ?? code;
export function Translations({
  messageId,
  messageLanguage,
  canRemove,
  locale,
}: {
  messageId: string;
  messageLanguage: string;
  canRemove: boolean;
  locale: string;
}) {
  const t = useTranslations();
  const [items, setItems] = useState<Item[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch(`/api/v1/messages/${messageId}/translations`).catch(() => null);
    const parsed = response?.ok ? z.array(itemSchema).safeParse(await response.json()) : null;
    if (parsed?.success) setItems(parsed.data);
    else setFailed(true);
  }, [messageId]);
  useEffect(() => {
    void load();
  }, [load]);
  // The worker translates; follow it until nothing is waiting.
  const waiting = items?.some((item) => item.status === "queued") === true;
  useEffect(() => {
    if (!waiting) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (attempts > 60) window.clearInterval(timer);
      else void load();
    }, 2_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [waiting, load]);
  async function request(language: string): Promise<void> {
    setFailed(false);
    const response = await fetch(`/api/v1/messages/${messageId}/translations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language }),
    }).catch(() => null);
    if (!response?.ok) setFailed(true);
    await load();
  }
  async function remove(): Promise<void> {
    const response = await fetch(`/api/v1/messages/${messageId}/translations/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    if (!response?.ok) setFailed(true);
    await load();
  }
  const targets = locales.filter((code) => code !== messageLanguage.split("-")[0]);
  return (
    <div className="translations">
      <div className="translations-actions">
        {targets.map((code) => (
          <button
            key={code}
            type="button"
            className="secondary"
            disabled={
              items?.some(
                (item) => item.language === code && item.current && item.status !== "failed",
              ) === true
            }
            onClick={() => {
              void request(code);
            }}
          >
            {t("translateInto", { language: languageName(locale, code) })}
          </button>
        ))}
        {canRemove && items !== null && items.length > 0 && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void remove();
            }}
          >
            {t("translationRemove")}
          </button>
        )}
      </div>
      {failed && (
        <small className="error" role="alert">
          {t("translationError")}
        </small>
      )}
      {items?.map((item) => (
        <section
          key={item.id}
          className="translation"
          aria-label={languageName(locale, item.language)}
        >
          <small className="muted">
            {t("translationMachine", {
              language: languageName(locale, item.language),
              model: item.model ?? "?",
              revision: item.profileRevision ?? 0,
            })}
          </small>
          {item.status === "ready" && item.html !== null && (
            <div className="prose" dangerouslySetInnerHTML={{ __html: item.html }} />
          )}
          {item.status === "queued" && <small role="status">{t("translationQueued")}</small>}
          {item.status === "failed" && (
            <small className="attention">
              {t("translationFailed", { code: item.error ?? "unknown" })}
            </small>
          )}
          {(item.status === "stale" || !item.current) && (
            <small className="attention">{t("translationStale")}</small>
          )}
        </section>
      ))}
    </div>
  );
}
