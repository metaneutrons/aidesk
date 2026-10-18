"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";
// The life of the projects: a project that a person manages is archived here, and an archived project is restored.
// An archived project keeps its data and is read-only: it takes no mail and is left out of the lists.
const archivedSchema = z.object({ id: z.string(), name: z.string(), archivedAt: z.string() });
type Message = "archived" | "restored" | "error";
export function ProjectLifecycle({
  manageable,
  locale,
}: {
  manageable: { id: string; name: string }[];
  locale: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const titleId = useId();
  const [archived, setArchived] = useState<z.infer<typeof archivedSchema>[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: Message; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/v1/projects?archived=only").catch(() => null);
    const parsed = response?.ok ? z.array(archivedSchema).safeParse(await response.json()) : null;
    if (parsed?.success) setArchived(parsed.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function send(id: string, name: string, action: "archive" | "restore") {
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    setMessage({
      text: response?.ok ? (action === "archive" ? "archived" : "restored") : "error",
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
                </span>
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
