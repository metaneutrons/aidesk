"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";
// The wording a project sets for itself: the acknowledgement, the line before
// the ticket link and the texts of the customer page. Each text has built-in
// wording in English and German; saving sets the project's own, and returning
// to the built-in wording is a change too (a new version).
const language = z.object({ default: z.string(), own: z.string().nullable(), version: z.number() });
const entrySchema = z.object({
  key: z.string(),
  description: z.string(),
  placeholders: z.array(z.string()),
  required: z.array(z.string()),
  languages: z.object({ en: language, de: language }),
});
type Entry = z.infer<typeof entrySchema>;
type Lang = "en" | "de";
type Message = "textApplied" | "textProposed" | "configStale" | "error";
const languageNames: Record<Lang, string> = { en: "English", de: "Deutsch" };
export function Texts({
  projectId,
  name,
  canWrite,
}: {
  projectId: string;
  name: string;
  canWrite: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const titleId = useId();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<Message | null>(null);
  // The text that is being translated, and why a suggestion could not be made.
  const [working, setWorking] = useState<string | null>(null);
  const [suggestFailed, setSuggestFailed] = useState<string | null>(null);
  // Drafts are cleared only after a save, so a slower load never takes away what
  // a person has typed.
  const load = useCallback(
    async (clearDrafts = false) => {
      const response = await fetch(`/api/v1/projects/${projectId}/texts`).catch(() => null);
      const parsed = response?.ok ? z.array(entrySchema).safeParse(await response.json()) : null;
      if (parsed?.success) {
        setEntries(parsed.data);
        if (clearDrafts) setDrafts({});
      }
    },
    [projectId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function write(entry: Entry, lang: Lang, text: string | null) {
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${projectId}/texts/${entry.key}/${lang}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        expectedVersion: entry.languages[lang].version,
        idempotencyKey: crypto.randomUUID(),
      }),
    }).catch(() => null);
    if (!response?.ok) setMessage(response?.status === 409 ? "configStale" : "error");
    else setMessage(response.status === 202 ? "textProposed" : "textApplied");
    await load(true);
    router.refresh();
  }
  // The wording in the other language as a suggestion in the field, to read, edit and save.
  async function suggest(entry: Entry, lang: Lang, from: Lang): Promise<void> {
    const id = `${entry.key}:${lang}`;
    setWorking(id);
    setSuggestFailed(null);
    const response = await fetch(`/api/v1/projects/${projectId}/texts/${entry.key}/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, language: lang }),
    }).catch(() => null);
    const body: unknown = response ? await response.json().catch(() => null) : null;
    const text = z.object({ text: z.string() }).safeParse(body);
    const code = z.object({ error: z.string() }).safeParse(body);
    if (response?.ok && text.success)
      setDrafts((current) => ({ ...current, [id]: text.data.text }));
    else setSuggestFailed(code.success ? code.data.error : "unavailable");
    setWorking(null);
  }
  if (entries === null) return null;
  return (
    <section className="texts" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("textsTitle", { project: name })}</h3>
      <p className="muted">{t("textsHint")}</p>
      {entries.map((entry) => (
        <fieldset key={entry.key} className="text-entry">
          <legend>{entry.description}</legend>
          {entry.placeholders.length > 0 && (
            <p className="muted">
              {t("textsPlaceholders", {
                list: entry.placeholders.map((placeholder) => `{${placeholder}}`).join(", "),
              })}
            </p>
          )}
          {(Object.keys(languageNames) as Lang[]).map((lang) => {
            const state = entry.languages[lang];
            const id = `${entry.key}:${lang}`;
            const shown = drafts[id] ?? state.own ?? state.default;
            const changed = shown !== (state.own ?? state.default);
            return (
              <div key={lang} className="text-language">
                <label>
                  <span>
                    {entry.description} ({languageNames[lang]})
                  </span>
                  <textarea
                    rows={3}
                    value={shown}
                    disabled={!canWrite}
                    maxLength={2000}
                    onChange={(event) => {
                      setDrafts({ ...drafts, [id]: event.target.value });
                    }}
                  />
                </label>
                {canWrite && (
                  <span className="configuration-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={!changed}
                      onClick={() => {
                        void write(entry, lang, shown);
                      }}
                    >
                      {t("textSave", { language: languageNames[lang] })}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={working !== null}
                      onClick={() => {
                        void suggest(entry, lang, lang === "en" ? "de" : "en");
                      }}
                    >
                      {t(working === id ? "textsTranslateWorking" : "textsTranslate", {
                        language: languageNames[lang === "en" ? "de" : "en"],
                      })}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={state.own === null}
                      onClick={() => {
                        void write(entry, lang, null);
                      }}
                    >
                      {t("textReset", { language: languageNames[lang] })}
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </fieldset>
      ))}
      {suggestFailed && (
        <p className="error" role="alert">
          {t("textsTranslateFailed", { code: suggestFailed })}
        </p>
      )}
      {message && (
        <p
          className={message === "error" || message === "configStale" ? "error" : "muted"}
          role="status"
        >
          {t(message)}
        </p>
      )}
    </section>
  );
}
