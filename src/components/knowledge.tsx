"use client";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { useZone } from "./time-zone";
// Search in the sources of knowledge of the ticket's project: what was found with its source and
// the time it was fetched, and which sources could not be read. Nothing is filled in for a source
// that does not answer. The text comes from outside and is shown as text.
const resultSchema = z.object({
  passages: z.array(
    z.object({
      connectionId: z.string(),
      kind: z.string(),
      source: z.string(),
      reference: z.string(),
      title: z.string(),
      text: z.string(),
      fetchedAt: z.string(),
    }),
  ),
  sources: z.array(
    z.object({
      connectionId: z.string(),
      name: z.string(),
      state: z.enum(["ok", "unavailable", "not_verified"]),
      error: z.string().nullable(),
    }),
  ),
});
type Result = z.infer<typeof resultSchema>;
const link = (reference: string): string | null =>
  /^https?:\/\//.test(reference) ? reference : null;
export function Knowledge({ ticketId, locale }: { ticketId: string; locale: string }) {
  const t = useTranslations();
  const zone = useZone();
  const id = useId();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  async function search(): Promise<void> {
    setWorking(true);
    setFailed(false);
    const response = await fetch(
      `/api/v1/tickets/${ticketId}/knowledge?q=${encodeURIComponent(query.trim())}`,
    ).catch(() => null);
    const parsed = response?.ok ? resultSchema.safeParse(await response.json()) : null;
    if (parsed?.success) setResult(parsed.data);
    else setFailed(true);
    setWorking(false);
  }
  const format = new Intl.DateTimeFormat(locale, {
    ...zone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <div className="knowledge">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim().length >= 2) void search();
        }}
      >
        <label htmlFor={`${id}-q`} className="visually-hidden">
          {t("knowledgePlaceholder")}
        </label>
        <input
          id={`${id}-q`}
          type="search"
          placeholder={t("knowledgePlaceholder")}
          maxLength={200}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <button type="submit" className="secondary" disabled={working || query.trim().length < 2}>
          {t("knowledgeSearch")}
        </button>
      </form>
      {failed && (
        <small className="error" role="alert">
          {t("knowledgeError")}
        </small>
      )}
      {result && (
        <div role="status">
          {result.sources.length === 0 && (
            <small className="muted">{t("knowledgeNoSources")}</small>
          )}
          {result.sources
            .filter((source) => source.state !== "ok")
            .map((source) => (
              <small key={source.connectionId} className="attention">
                {source.state === "not_verified"
                  ? t("knowledgeNotVerified", { name: source.name })
                  : t("knowledgeUnavailable", { name: source.name, code: source.error ?? "?" })}
              </small>
            ))}
          {result.sources.length > 0 && result.passages.length === 0 && (
            <small className="muted">{t("knowledgeNone")}</small>
          )}
          <ul className="knowledge-list">
            {result.passages.map((passage, index) => (
              <li key={`${passage.connectionId}:${String(index)}`}>
                <strong>{passage.title}</strong>
                <p>{passage.text}</p>
                <small className="muted">
                  {passage.source} ·{" "}
                  {link(passage.reference) ? (
                    <a href={link(passage.reference) ?? undefined} rel="noreferrer" target="_blank">
                      {passage.reference}
                    </a>
                  ) : (
                    passage.reference
                  )}{" "}
                  · {t("knowledgeFetched", { date: format.format(new Date(passage.fetchedAt)) })}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
