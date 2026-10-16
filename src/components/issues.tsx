"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
// The issues of the repositories of the project, from a ticket: the linked ones with their last
// known state, a search, and drafts that a person writes, reads exactly as they will go out, and
// publishes. A project without a repository has nothing of this to show. Nothing is taken from the
// ticket into an issue; closing an issue changes nothing about the ticket.
const stateSchema = z.object({
  repositories: z.array(z.object({ connectionId: z.string(), repository: z.string() })),
  links: z.array(
    z.object({
      id: z.string(),
      repository: z.string(),
      number: z.number(),
      url: z.string(),
      title: z.string(),
      state: z.string().nullable(),
      origin: z.string(),
      refreshError: z.string().nullable(),
    }),
  ),
  drafts: z.array(
    z.object({
      id: z.string(),
      repository: z.string(),
      title: z.string(),
      body: z.string(),
      state: z.string(),
      version: z.number(),
      errorCode: z.string().nullable(),
      publishedNumber: z.number().nullable(),
      publishedUrl: z.string().nullable(),
    }),
  ),
});
type State = z.infer<typeof stateSchema>;
type Draft = State["drafts"][number];
const found = z.object({
  issues: z.array(
    z.object({
      repository: z.string(),
      number: z.number(),
      title: z.string(),
      state: z.string(),
      url: z.string(),
      pullRequest: z.boolean(),
    }),
  ),
  problems: z.array(z.object({ repository: z.string(), error: z.string() })),
});
const post = (url: string, body: unknown, method = "POST") =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
const safe = (url: string) => (/^https?:\/\//.test(url) ? url : undefined);
function DraftCard({
  draft,
  canNote,
  canPublish,
  act,
}: {
  draft: Draft;
  canNote: boolean;
  canPublish: boolean;
  act: (call: Promise<Response | null>) => Promise<void>;
}) {
  const t = useTranslations();
  const id = useId();
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [reviewing, setReviewing] = useState(false);
  const open = draft.state === "draft" || draft.state === "failed";
  const changed = title !== draft.title || body !== draft.body;
  return (
    <li className="issue-draft">
      <strong>
        {draft.repository}: {draft.title}
      </strong>{" "}
      <span className={draft.state === "draft" ? "muted" : "attention"}>
        {t(`issueDraft_${draft.state}`)}
        {draft.errorCode ? ` (${draft.errorCode})` : ""}
      </span>
      {draft.state === "published" && draft.publishedUrl && (
        <a href={safe(draft.publishedUrl)} rel="noreferrer" target="_blank">
          {" "}
          #{draft.publishedNumber}
        </a>
      )}
      {open && canNote && (
        <div className="issue-form">
          <label htmlFor={`${id}-t`}>{t("issueTitle")}</label>
          <input
            id={`${id}-t`}
            maxLength={256}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <label htmlFor={`${id}-b`}>{t("issueBody")}</label>
          <textarea
            id={`${id}-b`}
            rows={4}
            maxLength={20_000}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
          <div className="configuration-actions">
            <button
              type="button"
              className="secondary"
              disabled={!changed || !title.trim()}
              onClick={() => {
                void act(
                  post(
                    `/api/v1/issue-drafts/${draft.id}`,
                    { title, body, expectedVersion: draft.version },
                    "PUT",
                  ),
                );
              }}
            >
              {t("issueSaveChanges")}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={changed}
              onClick={() => {
                setReviewing((value) => !value);
              }}
            >
              {t("issueReview")}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                void act(post(`/api/v1/issue-drafts/${draft.id}/discard`, {}));
              }}
            >
              {t("issueDiscard")}
            </button>
          </div>
        </div>
      )}
      {reviewing && open && (
        <div className="issue-review" role="group" aria-label={t("issueReview")}>
          <small className="muted">{t("issueReviewHint", { repository: draft.repository })}</small>
          <pre>{`${draft.title}\n\n${draft.body}`}</pre>
          {canPublish ? (
            <button
              type="button"
              className="primary"
              onClick={() => {
                void act(
                  post(`/api/v1/issue-drafts/${draft.id}/publish`, {
                    expectedVersion: draft.version,
                  }),
                );
              }}
            >
              {t("issuePublish")}
            </button>
          ) : (
            <small className="attention">{t("issueNoPublish")}</small>
          )}
        </div>
      )}
      {draft.state === "uncertain" && (
        <div>
          <small className="attention">{t("issueUncertain")}</small>
          {canPublish && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                void act(post(`/api/v1/issue-drafts/${draft.id}/reconcile`, {}));
              }}
            >
              {t("issueCheck")}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
export function Issues({
  ticketId,
  canNote,
  canPublish,
}: {
  ticketId: string;
  canNote: boolean;
  canPublish: boolean;
}) {
  const t = useTranslations();
  const id = useId();
  const [state, setState] = useState<State | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<z.infer<typeof found> | null>(null);
  const [repository, setRepository] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(`/api/v1/tickets/${ticketId}/issues`).catch(() => null);
    const parsed = response?.ok ? stateSchema.safeParse(await response.json()) : null;
    if (parsed?.success) setState(parsed.data);
  }, [ticketId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function act(call: Promise<Response | null>): Promise<void> {
    setFailed(false);
    const response = await call;
    if (!response?.ok) setFailed(true);
    await load();
  }
  if (state === null || state.repositories.length === 0) return null;
  const chosen = repository === "" ? (state.repositories[0]?.repository ?? "") : repository;
  return (
    <details className="ticket-issues">
      <summary>{t("issuesToggle")}</summary>
      {failed && (
        <small className="error" role="alert">
          {t("issueError")}
        </small>
      )}
      <ul className="issue-list">
        {state.links.map((link) => (
          <li key={link.id}>
            <a href={safe(link.url)} rel="noreferrer" target="_blank">
              {link.repository}#{link.number}
            </a>{" "}
            {link.title}{" "}
            <span className={link.state === "closed" ? "muted" : ""}>
              ({link.state ?? t("issueStateUnknown")})
            </span>
            {link.refreshError && (
              <small className="attention">
                {" "}
                {t("issueNotRefreshed", { code: link.refreshError })}
              </small>
            )}
            {canNote && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  void act(post(`/api/v1/tickets/${ticketId}/issues/${link.id}/unlink`, {}));
                }}
              >
                {t("issueUnlink")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {state.links.length > 0 && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void act(post(`/api/v1/tickets/${ticketId}/issues/refresh`, {}));
          }}
        >
          {t("issueRefresh")}
        </button>
      )}
      <form
        className="issue-search"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            const response = await fetch(
              `/api/v1/tickets/${ticketId}/issues/search?q=${encodeURIComponent(query.trim())}`,
            ).catch(() => null);
            const parsed = response?.ok ? found.safeParse(await response.json()) : null;
            if (parsed?.success) setResults(parsed.data);
            else setFailed(true);
          })();
        }}
      >
        <label htmlFor={`${id}-q`} className="visually-hidden">
          {t("issueSearch")}
        </label>
        <input
          id={`${id}-q`}
          type="search"
          placeholder={t("issueSearch")}
          maxLength={200}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <button type="submit" className="secondary" disabled={query.trim().length < 2}>
          {t("knowledgeSearch")}
        </button>
      </form>
      {results && (
        <div role="status">
          {results.problems.map((problem) => (
            <small key={problem.repository} className="attention">
              {t("knowledgeUnavailable", { name: problem.repository, code: problem.error })}
            </small>
          ))}
          {results.issues.length === 0 && results.problems.length === 0 && (
            <small className="muted">{t("knowledgeNone")}</small>
          )}
          <ul className="issue-list">
            {results.issues.map((issue) => (
              <li key={`${issue.repository}#${String(issue.number)}`}>
                <a href={safe(issue.url)} rel="noreferrer" target="_blank">
                  {issue.repository}#{issue.number}
                </a>{" "}
                {issue.title} ({issue.state})
                {canNote && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      void act(
                        post(`/api/v1/tickets/${ticketId}/issues/link`, {
                          repository: issue.repository,
                          number: issue.number,
                        }),
                      );
                    }}
                  >
                    {t("issueLink")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="issue-list">
        {state.drafts.map((draft) => (
          <DraftCard
            key={`${draft.id}:${String(draft.version)}:${draft.state}`}
            draft={draft}
            canNote={canNote}
            canPublish={canPublish}
            act={act}
          />
        ))}
      </ul>
      {canNote && (
        <form
          className="issue-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              post(`/api/v1/tickets/${ticketId}/issue-drafts`, {
                repository: chosen,
                title,
                body,
              }),
            ).then(() => {
              setTitle("");
              setBody("");
            });
          }}
        >
          <p className="muted">{t("issueNewHint")}</p>
          {state.repositories.length > 1 && (
            <label>
              {t("issueRepository")}
              <select
                value={chosen}
                onChange={(event) => {
                  setRepository(event.target.value);
                }}
              >
                {state.repositories.map((entry) => (
                  <option key={entry.repository} value={entry.repository}>
                    {entry.repository}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {t("issueTitle")}
            <input
              maxLength={256}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
          </label>
          <label>
            {t("issueBody")}
            <textarea
              rows={4}
              maxLength={20_000}
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
              }}
            />
          </label>
          <button type="submit" className="secondary" disabled={!title.trim()}>
            {t("issueSaveDraft")}
          </button>
        </form>
      )}
    </details>
  );
}
