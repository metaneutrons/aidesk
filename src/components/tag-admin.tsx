"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { textOn } from "../domain/branding";
import { normalizeTag, tagAdminOut, tagPattern, tagStyle } from "../domain/tags";
// The tags of a project with the number of tickets and a colour each: renamed, merged into another, coloured and
// removed from all tickets. Removing asks first and names the number of tickets that it concerns.
const listSchema = z.array(tagAdminOut);
type Entry = z.infer<typeof tagAdminOut>;
type Problem = "conflict" | "stale" | "missing" | "error";
export function TagAdmin({ projectId, name }: { projectId: string; name: string }) {
  const t = useTranslations();
  const titleId = useId();
  const [tags, setTags] = useState<Entry[] | null>(null);
  const [renaming, setRenaming] = useState<{ tag: string; to: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const base = `/api/v1/projects/${projectId}/tag-admin`;
  const load = useCallback(
    async (current: () => boolean = () => true) => {
      const response = await fetch(base).catch(() => null);
      const parsed = response?.ok ? listSchema.safeParse(await response.json()) : null;
      if (parsed?.success && current()) setTags(parsed.data);
    },
    [base],
  );
  useEffect(() => {
    const run = { current: true };
    void load(() => run.current);
    return () => {
      run.current = false;
    };
  }, [load]);
  if (tags === null) return null;
  async function send(path: string, payload: object) {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    setProblem(
      response?.ok
        ? null
        : response?.status === 409
          ? path === "/remove"
            ? "stale"
            : "conflict"
          : response?.status === 404
            ? "missing"
            : "error",
    );
    const result = response?.ok
      ? z.object({ tickets: z.number() }).safeParse(await response.json())
      : null;
    setDone(result?.success && path !== "/color" ? result.data.tickets : null);
    await load();
    return Boolean(response?.ok);
  }
  const problemText = {
    conflict: "tagAdminConflict",
    stale: "tagAdminStale",
    missing: "tagAdminMissing",
    error: "error",
  } as const;
  return (
    <section className="connections tag-admin" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("tagAdminTitle", { project: name })}</h3>
      <p className="muted">{t("tagAdminHint")}</p>
      {problem && (
        <p className="error" role="alert">
          {t(problemText[problem])}
        </p>
      )}
      {done !== null && (
        <p className="muted" role="status">
          {t("tagAdminDone", { count: done })}
        </p>
      )}
      {tags.length === 0 ? (
        <p className="muted">{t("tagAdminNone")}</p>
      ) : (
        <ul className="connection-list">
          {tags.map((entry) => (
            <li key={entry.tag}>
              <span>
                <span className="tag-chip" style={tagStyle(entry.color ?? undefined, textOn)}>
                  {entry.tag}
                </span>{" "}
                <span className="muted">{t("tagAdminTickets", { count: entry.tickets })}</span>
              </span>
              <span className="connection-actions">
                <label>
                  <span className="visually-hidden">{t("tagAdminColor", { tag: entry.tag })}</span>
                  <input
                    type="color"
                    value={entry.color ?? "#808080"}
                    aria-label={t("tagAdminColor", { tag: entry.tag })}
                    onChange={(event) => {
                      void send("/color", { tag: entry.tag, color: event.target.value });
                    }}
                  />
                </label>
                {entry.color !== null && (
                  <button
                    type="button"
                    className="secondary"
                    aria-label={t("tagAdminNoColor", { tag: entry.tag })}
                    onClick={() => {
                      void send("/color", { tag: entry.tag, color: null });
                    }}
                  >
                    {t("tagAdminNoColorShort")}
                  </button>
                )}
                <button
                  type="button"
                  className="secondary"
                  aria-label={t("tagAdminRename", { tag: entry.tag })}
                  onClick={() => {
                    setRenaming({ tag: entry.tag, to: entry.tag });
                  }}
                >
                  {t("tagAdminRenameShort")}
                </button>
                {tags.length > 1 && (
                  <select
                    aria-label={t("tagAdminMerge", { tag: entry.tag })}
                    value=""
                    onChange={(event) => {
                      if (event.target.value)
                        void send("/merge", { from: [entry.tag], into: event.target.value });
                    }}
                  >
                    <option value="">{t("tagAdminMergeShort")}</option>
                    {tags
                      .filter((other) => other.tag !== entry.tag)
                      .map((other) => (
                        <option key={other.tag} value={other.tag}>
                          {other.tag}
                        </option>
                      ))}
                  </select>
                )}
                {confirming === entry.tag ? (
                  <>
                    <span role="alert">
                      {t("tagAdminAsk", { tag: entry.tag, count: entry.tickets })}
                    </span>
                    <button
                      type="button"
                      aria-label={t("tagAdminConfirm", { tag: entry.tag })}
                      onClick={() => {
                        setConfirming(null);
                        void send("/remove", { tag: entry.tag, expectedTickets: entry.tickets });
                      }}
                    >
                      {t("tagAdminConfirmShort")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setConfirming(null);
                      }}
                    >
                      {t("tagAdminCancel")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    aria-label={t("tagAdminRemove", { tag: entry.tag })}
                    onClick={() => {
                      setConfirming(entry.tag);
                    }}
                  >
                    {t("tagAdminRemoveShort")}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {renaming && (
        <form
          className="tag-rename"
          aria-label={t("tagAdminRenameForm", { tag: renaming.tag })}
          onSubmit={(event) => {
            event.preventDefault();
            const to = normalizeTag(renaming.to);
            if (tagPattern.test(to) && to !== renaming.tag)
              void send("/rename", { from: renaming.tag, to }).then((ok) => {
                if (ok) setRenaming(null);
              });
          }}
        >
          <label>
            {t("tagAdminNewName")}
            <input
              value={renaming.to}
              maxLength={60}
              onChange={(event) => {
                setRenaming({ ...renaming, to: event.target.value });
              }}
            />
          </label>
          <button
            type="submit"
            disabled={
              !tagPattern.test(normalizeTag(renaming.to)) ||
              normalizeTag(renaming.to) === renaming.tag
            }
          >
            {t("tagAdminRenameSave")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setRenaming(null);
            }}
          >
            {t("tagAdminCancel")}
          </button>
        </form>
      )}
    </section>
  );
}
