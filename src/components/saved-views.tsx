"use client";
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { viewListOut, viewLists, type SavedView, type ViewList } from "../domain/views";
import type { Priority } from "../domain/triage";
// The saved views of the inbox: a choice applies the filters of a view, the current filters can be saved under a name, a
// chosen view can be updated with them, made the one that the desk opens with, or deleted. A view whose projects the
// person may not read any more is listed and cannot be applied.
export interface CurrentFilters {
  list: string;
  projects: string[];
  tag: string | null;
  priority: Priority | "";
  category: string;
}
type Failure = "conflict" | "limit" | "error" | null;
export function SavedViews({
  views,
  current,
  onChange,
  onApply,
}: {
  views: SavedView[];
  current: CurrentFilters;
  onChange: (views: SavedView[]) => void;
  onApply: (view: SavedView) => void;
}) {
  const t = useTranslations();
  const nameId = useId();
  const [chosen, setChosen] = useState("");
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [failure, setFailure] = useState<Failure>(null);
  const list = viewLists.find((entry) => entry === current.list) ?? null;
  const picked = views.find((entry) => entry.id === chosen) ?? null;
  const filters = (): Omit<SavedView, "id" | "name" | "restricted" | "start"> | null =>
    list
      ? {
          list: list satisfies ViewList,
          projects: current.projects,
          tag: current.tag,
          priority: current.priority === "" ? null : current.priority,
          category: current.category === "" ? null : current.category,
        }
      : null;
  async function send(path: string, method: "POST" | "PUT", body: unknown): Promise<boolean> {
    setFailure(null);
    const response = await fetch(`/api/v1/me/views${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const parsed = response?.ok ? viewListOut.safeParse(await response.json()) : null;
    if (parsed?.success) {
      onChange(parsed.data.views);
      return true;
    }
    setFailure(response?.status === 409 ? (views.length >= 20 ? "limit" : "conflict") : "error");
    return false;
  }
  return (
    <div className="saved-views">
      <label>
        <span className="visually-hidden">{t("viewsChoose")}</span>
        <select
          value={chosen}
          aria-label={t("viewsChoose")}
          onChange={(event) => {
            setChosen(event.target.value);
            const view = views.find((entry) => entry.id === event.target.value);
            if (view && !view.restricted) onApply(view);
          }}
        >
          <option value="">{t("viewsNone")}</option>
          {views.map((view) => (
            <option key={view.id} value={view.id} disabled={view.restricted}>
              {view.name}
              {view.start ? ` ${t("viewsStartMark")}` : ""}
              {view.restricted ? ` ${t("viewsNoAccess")}` : ""}
            </option>
          ))}
        </select>
      </label>
      {naming ? (
        <form
          className="saved-view-form"
          onSubmit={(event) => {
            event.preventDefault();
            const values = filters();
            if (!values || name.trim() === "") return;
            void send("", "POST", { name, ...values }).then((done) => {
              if (done) {
                setNaming(false);
                setName("");
              }
            });
          }}
        >
          <label htmlFor={nameId}>{t("viewsName")}</label>
          <input
            id={nameId}
            value={name}
            maxLength={60}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <button className="primary" type="submit" disabled={name.trim() === ""}>
            {t("viewsSave")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setNaming(false);
              setFailure(null);
            }}
          >
            {t("viewsCancel")}
          </button>
        </form>
      ) : (
        <>
          <button
            type="button"
            className="secondary"
            disabled={list === null}
            onClick={() => {
              setNaming(true);
            }}
          >
            {t("viewsSaveCurrent")}
          </button>
          {picked && (
            <>
              <button
                type="button"
                className="secondary"
                disabled={list === null}
                onClick={() => {
                  const values = filters();
                  if (values) void send(`/${picked.id}`, "PUT", values);
                }}
              >
                {t("viewsUpdate")}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  void send(`/${picked.id}/start`, "POST", { start: !picked.start });
                }}
              >
                {picked.start ? t("viewsStartOff") : t("viewsStartOn")}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  void send(`/${picked.id}/delete`, "POST", {}).then((done) => {
                    if (done) setChosen("");
                  });
                }}
              >
                {t("viewsDelete")}
              </button>
            </>
          )}
        </>
      )}
      {failure && (
        <p className="error" role="alert">
          {t(
            failure === "conflict"
              ? "viewsNameUsed"
              : failure === "limit"
                ? "viewsLimit"
                : "viewsError",
          )}
        </p>
      )}
    </div>
  );
}
