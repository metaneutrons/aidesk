"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";
// The life of the projects: a project that a person manages is archived here, and an archived project is restored.
// An archived project keeps its data and is read-only: it takes no mail and is left out of the lists.
const archivedSchema = z.object({ id: z.string(), name: z.string(), archivedAt: z.string() });
const exportSchema = z.object({
  id: z.string(),
  digest: z.string(),
  bytes: z.number(),
  createdAt: z.string(),
});
type Export = z.infer<typeof exportSchema>;
type Message =
  "archived" | "restored" | "exported" | "deleted" | "tooLarge" | "needsExport" | "error";
export function ProjectLifecycle({
  manageable,
  locale,
  owner,
}: {
  manageable: { id: string; name: string }[];
  locale: string;
  owner: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const titleId = useId();
  const [archived, setArchived] = useState<z.infer<typeof archivedSchema>[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [exports, setExports] = useState<Record<string, Export[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ text: Message; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/v1/projects?archived=only").catch(() => null);
    const parsed = response?.ok ? z.array(archivedSchema).safeParse(await response.json()) : null;
    if (parsed?.success) {
      setArchived(parsed.data);
      // The exports of each archived project, newest first.
      const found: Record<string, Export[]> = {};
      for (const project of parsed.data) {
        const listed = await fetch(`/api/v1/projects/${project.id}/exports`).catch(() => null);
        const list = listed?.ok ? z.array(exportSchema).safeParse(await listed.json()) : null;
        found[project.id] = list?.success ? list.data : [];
      }
      setExports(found);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function send(
    id: string,
    name: string,
    action: "archive" | "restore" | "exports" | "delete",
    body: unknown = {},
  ) {
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const code =
      response && !response.ok
        ? ((await response.json().catch(() => null)) as { error?: string } | null)?.error
        : undefined;
    const done = {
      archive: "archived",
      restore: "restored",
      exports: "exported",
      delete: "deleted",
    } as const;
    setMessage({
      text: response?.ok
        ? done[action]
        : code === "project_export_too_large"
          ? "tooLarge"
          : code === "export_required"
            ? "needsExport"
            : "error",
      name,
    });
    setConfirming(null);
    await load();
    router.refresh();
    setBusy(false);
  }
  if (archived === null || (manageable.length === 0 && archived.length === 0)) return null;
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  return (
    <section className="connections project-lifecycle" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("projectLifecycleTitle")}</h3>
      <p className="muted">{t("projectLifecycleHint")}</p>
      {manageable.length > 0 && (
        <ul className="connection-list">
          {manageable.map((project) => (
            <li key={project.id}>
              <strong>{project.name}</strong>
              <span className="connection-actions">
                {confirming === project.id ? (
                  <>
                    <span className="attention">{t("projectArchiveAsk")}</span>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => {
                        void send(project.id, project.name, "archive");
                      }}
                    >
                      {t("projectArchiveConfirm", { name: project.name })}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setConfirming(null);
                      }}
                    >
                      {t("projectArchiveCancel")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setConfirming(project.id);
                    }}
                  >
                    {t("projectArchive", { name: project.name })}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <>
          <h4>{t("projectArchivedTitle")}</h4>
          <ul className="connection-list">
            {archived.map((project) => (
              <li key={project.id}>
                <span>
                  <strong>{project.name}</strong>{" "}
                  <span className="muted">
                    {t("projectArchivedSince", { date: when.format(new Date(project.archivedAt)) })}
                  </span>
                </span>
                <span className="connection-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      void send(project.id, project.name, "restore");
                    }}
                  >
                    {t("projectRestore", { name: project.name })}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      void send(project.id, project.name, "exports");
                    }}
                  >
                    {t("projectExport", { name: project.name })}
                  </button>
                </span>
                {(exports[project.id] ?? []).slice(0, 1).map((made) => (
                  <small key={made.id} className="project-export muted">
                    {t("projectExportLatest", {
                      date: when.format(new Date(made.createdAt)),
                      size: (made.bytes / 1024 / 1024).toFixed(1),
                      digest: made.digest.slice(0, 16),
                    })}{" "}
                    <a href={`/api/v1/projects/${project.id}/exports/${made.id}`} download>
                      {t("projectExportDownload", { name: project.name })}
                    </a>
                  </small>
                ))}
                {owner && (
                  <form
                    className="project-delete"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const latest = (exports[project.id] ?? [])[0];
                      if (latest)
                        void send(project.id, project.name, "delete", {
                          confirmName: typed[project.id] ?? "",
                          exportId: latest.id,
                        });
                    }}
                  >
                    <label>
                      <span>{t("projectDeleteType", { name: project.name })}</span>
                      <input
                        type="text"
                        autoComplete="off"
                        value={typed[project.id] ?? ""}
                        onChange={(event) => {
                          setTyped({ ...typed, [project.id]: event.target.value });
                        }}
                      />
                    </label>
                    <button
                      type="submit"
                      className="secondary danger"
                      disabled={
                        busy ||
                        (typed[project.id] ?? "") !== project.name ||
                        !(exports[project.id] ?? []).some(
                          (made) => made.createdAt >= project.archivedAt,
                        )
                      }
                    >
                      {t("projectDelete", { name: project.name })}
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {message && (
        <p className={message.text === "error" ? "error" : "muted"} role="status">
          {t(`projectMessage_${message.text}`, { name: message.name })}
        </p>
      )}
    </section>
  );
}
