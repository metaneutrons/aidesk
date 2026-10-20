"use client";
import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { processingOverview, type ProcessingEntry } from "../domain/processing";
// Where the content of the tickets of a project goes: the outgoing mail connection, the models of the tasks, the
// sources of knowledge and the webhooks, with the address, what each receives and what is missing. The page reads the
// configuration and changes nothing; the same list can be taken out as a file for the records of processing.
const groups = ["mail_out", "mail_in", "ai", "knowledge", "webhook"] as const;
const taskLabel = (task: string) => `aiTask_${task.replace(".", "_")}`;
export function Processing({ projectId, name }: { projectId: string; name: string }) {
  const t = useTranslations();
  const titleId = useId();
  const [overview, setOverview] = useState<z.infer<typeof processingOverview> | null>(null);
  useEffect(() => {
    const run = { current: true };
    void (async () => {
      const response = await fetch(`/api/v1/projects/${projectId}/processing`).catch(() => null);
      const parsed = response?.ok ? processingOverview.safeParse(await response.json()) : null;
      if (parsed?.success && run.current) setOverview(parsed.data);
    })();
    return () => {
      run.current = false;
    };
  }, [projectId]);
  if (overview === null) return null;
  const label = (entry: ProcessingEntry) =>
    entry.task ? t(taskLabel(entry.task)) : entry.name || t("processingNothing");
  return (
    <section className="connections processing" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("processingTitle", { project: name })}</h3>
      <p className="muted">{t("processingHint")}</p>
      <p>
        <a href={`/api/v1/projects/${projectId}/processing/export`} download>
          {t("processingExport")}
        </a>
        {overview.withIssues > 0 && (
          <span className="error" role="status">
            {" "}
            {t("processingIssues", { count: overview.withIssues })}
          </span>
        )}
      </p>
      {groups.map((group) => {
        const entries = overview.entries.filter((entry) => entry.group === group);
        if (entries.length === 0) return null;
        return (
          <div key={group}>
            <h4>{t(`processingGroup_${group}`)}</h4>
            <ul className="connection-list">
              {entries.map((entry) => (
                <li key={`${entry.group}:${entry.id}`}>
                  <span>
                    <strong>{label(entry)}</strong>{" "}
                    <span className="muted">
                      {[entry.kind !== "none" ? entry.kind : null, entry.host, entry.detail]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <br />
                    <span className="muted">
                      {entry.receives.length > 0
                        ? `${t("processingReceives")}: ${entry.receives.map((item) => t(`processingContent_${item}`)).join(", ")}`
                        : t("processingReceivesNothing")}
                    </span>
                  </span>
                  <span>
                    <span className="muted">{t(`processingState_${entry.state}`)}</span>
                    {entry.issues.map((issue) => (
                      <span key={issue} className="error">
                        {" "}
                        {t(`processingIssue_${issue}`)}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
