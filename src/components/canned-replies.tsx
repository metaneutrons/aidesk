"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { cannedLanguages, cannedOut, cannedPlaceholders, maxCannedBody } from "../domain/canned";
// The canned replies of a project: the list, and a form to add one or change one. A reply is a text with
// placeholders that is filled in for a ticket when it is used in the composer, by the draft button or by an agent.
const listSchema = z.array(cannedOut);
type Reply = z.infer<typeof cannedOut>;
interface Draft {
  name: string;
  language: string;
  body: string;
}
const empty: Draft = { name: "", language: "en", body: "" };
export function CannedReplies({
  projectId,
  name,
  canWrite,
}: {
  projectId: string;
  name: string;
  canWrite: boolean;
}) {
  const t = useTranslations();
  const titleId = useId();
  const [replies, setReplies] = useState<Reply[] | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [editing, setEditing] = useState<Reply | null>(null);
  const [problem, setProblem] = useState<"conflict" | "invalid" | "error" | null>(null);
  const base = `/api/v1/projects/${projectId}/canned-replies`;
  const load = useCallback(
    async (current: () => boolean = () => true) => {
      const response = await fetch(base).catch(() => null);
      const parsed = response?.ok ? listSchema.safeParse(await response.json()) : null;
      if (parsed?.success && current()) setReplies(parsed.data);
    },
    [base],
  );
  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);
  if (replies === null) return null;
  async function send(path: string, method: "POST" | "PUT", payload: object) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    setProblem(
      response?.ok
        ? null
        : response?.status === 409
          ? "conflict"
          : response?.status === 400
            ? "invalid"
            : "error",
    );
    await load();
    return Boolean(response?.ok);
  }
  async function save() {
    const done = editing
      ? await send(`/${editing.id}`, "PUT", { ...draft, expectedVersion: editing.version })
      : await send("", "POST", draft);
    if (done) {
      setDraft(empty);
      setEditing(null);
    }
  }
  const problemText = {
    conflict: "cannedConflict",
    invalid: "cannedInvalid",
    error: "error",
  } as const;
  return (
    <section className="connections canned-replies" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("cannedTitle", { project: name })}</h3>
      <p className="muted">
        {t("cannedHint", {
          placeholders: cannedPlaceholders.map((entry) => `{{${entry}}}`).join(", "),
        })}
      </p>
      {problem && (
        <p className="error" role="alert">
          {t(problemText[problem])}
        </p>
      )}
      {replies.length === 0 ? (
        <p className="muted">{t("cannedNone")}</p>
      ) : (
        <ul className="connection-list">
          {replies.map((reply) => (
            <li key={reply.id}>
              <span>
                <strong>{reply.name}</strong> <span className="muted">({reply.language})</span>
                <br />
                <span className="muted">{reply.body.slice(0, 160)}</span>
              </span>
              {canWrite && (
                <span className="connection-actions">
                  <button
                    type="button"
                    className="secondary"
                    aria-label={t("cannedEdit", { name: reply.name })}
                    onClick={() => {
                      setEditing(reply);
                      setDraft({ name: reply.name, language: reply.language, body: reply.body });
                    }}
                  >
                    {t("cannedEditShort")}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={t("cannedRemove", { name: reply.name })}
                    onClick={() => {
                      void send(`/${reply.id}/delete`, "POST", { expectedVersion: reply.version });
                    }}
                  >
                    {t("cannedRemoveShort")}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form
          className="canned-form"
          aria-label={t(editing ? "cannedEditForm" : "cannedAddForm")}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            {t("cannedName")}
            <input
              value={draft.name}
              maxLength={60}
              onChange={(event) => {
                setDraft({ ...draft, name: event.target.value });
              }}
            />
          </label>
          <label>
            {t("cannedLanguage")}
            <select
              value={draft.language}
              onChange={(event) => {
                setDraft({ ...draft, language: event.target.value });
              }}
            >
              {cannedLanguages.map((entry) => (
                <option key={entry} value={entry}>
                  {entry === "de" ? "Deutsch" : "English"}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("cannedBody")}
            <textarea
              rows={5}
              value={draft.body}
              maxLength={maxCannedBody}
              onChange={(event) => {
                setDraft({ ...draft, body: event.target.value });
              }}
            />
          </label>
          <button type="submit" disabled={draft.name.trim() === "" || draft.body.trim() === ""}>
            {t(editing ? "cannedSave" : "cannedAdd")}
          </button>
          {editing && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setEditing(null);
                setDraft(empty);
              }}
            >
              {t("cannedCancel")}
            </button>
          )}
        </form>
      )}
    </section>
  );
}
