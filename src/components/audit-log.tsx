"use client";
import { useCallback, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
// The audit of one project, or of the workspace for the owner: who did what to which object and when. It is
// read from the same list as the API, filtered by actor, action (a family when it ends with a dot), target and
// time, and exported with the same filters. The entries hold no ticket content, secrets or customer addresses;
// the detail shows what the server hands out and nothing more.
const entrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actorId: z.string(),
  actorName: z.string().nullable(),
  actorKind: z.enum(["user", "agent", "customer", "unknown"]),
  action: z.string(),
  targetId: z.string().nullable(),
  detail: z.unknown(),
});
const pageSchema = z.object({ entries: z.array(entrySchema), next: z.string().nullable() });
type Entry = z.infer<typeof entrySchema>;
interface Filters {
  actor: string;
  action: string;
  target: string;
  from: string;
  to: string;
}
const empty: Filters = { actor: "", action: "", target: "", from: "", to: "" };
function query(filters: Filters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  for (const key of ["actor", "action", "target"] as const)
    if (filters[key].trim()) params.set(key, filters[key].trim());
  for (const key of ["from", "to"] as const) {
    const time = filters[key] ? new Date(filters[key]) : null;
    if (time && !Number.isNaN(time.getTime())) params.set(key, time.toISOString());
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}
export function AuditLog({
  projectId,
  name,
  locale,
}: {
  projectId: string | null;
  name: string;
  locale: string;
}) {
  const t = useTranslations();
  const titleId = useId();
  const base = projectId ? `/api/v1/projects/${projectId}/audit` : "/api/v1/audit";
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(empty);
  const [applied, setApplied] = useState<Filters>(empty);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // A slower answer to an earlier filter never replaces the answer to the current one.
  const round = useRef(0);
  const load = useCallback(
    async (using: Filters, cursor: string | null) => {
      const mine = ++round.current;
      setBusy(true);
      setFailed(false);
      const response = await fetch(
        `${base}${query(using, cursor ? { before: cursor } : {})}`,
      ).catch(() => null);
      const parsed = response?.ok ? pageSchema.safeParse(await response.json()) : null;
      if (mine !== round.current) return;
      if (parsed?.success) {
        setEntries((current) =>
          cursor && current ? [...current, ...parsed.data.entries] : parsed.data.entries,
        );
        setNext(parsed.data.next);
      } else setFailed(true);
      setBusy(false);
    },
    [base],
  );
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" });
  const heading = projectId ? t("auditTitle", { project: name }) : t("auditTitleWorkspace");
  const field = (key: keyof Filters, label: string, type = "text", hint?: string) => (
    <label>
      <span>{label}</span>
      <input
        type={type}
        value={filters[key]}
        maxLength={100}
        aria-describedby={hint ? `${titleId}-${key}-hint` : undefined}
        onChange={(event) => {
          setFilters({ ...filters, [key]: event.target.value });
        }}
      />
      {hint && (
        <small id={`${titleId}-${key}-hint`} className="muted">
          {hint}
        </small>
      )}
    </label>
  );
  return (
    <section className="connections audit-log" aria-labelledby={`${titleId}-title`}>
      <details
        open={open}
        onToggle={(event) => {
          const shown = event.currentTarget.open;
          setOpen(shown);
          if (shown && entries === null) void load(applied, null);
        }}
      >
        <summary>
          <h3 id={`${titleId}-title`}>{heading}</h3>
        </summary>
        <p className="muted">{t("auditHint")}</p>
        <form
          className="audit-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied(filters);
            void load(filters, null);
          }}
        >
          {field("actor", t("auditActor"))}
          {field("action", t("auditAction"), "text", t("auditActionHint"))}
          {field("target", t("auditTarget"))}
          {field("from", t("auditFrom"), "datetime-local")}
          {field("to", t("auditTo"), "datetime-local")}
          <span className="configuration-actions">
            <button type="submit" className="primary" disabled={busy}>
              {t("auditApply")}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setFilters(empty);
                setApplied(empty);
                void load(empty, null);
              }}
            >
              {t("auditReset")}
            </button>
            <a
              className="secondary"
              href={`${base}/export${query(applied)}`}
              download
              aria-label={t("auditExportLabel", { scope: projectId ? name : t("auditWorkspace") })}
            >
              {t("auditExport")}
            </a>
          </span>
        </form>
        {failed && (
          <p className="error" role="alert">
            {t("auditError")}
          </p>
        )}
        {entries !== null && entries.length === 0 && !failed && (
          <p className="muted">{t("auditNone")}</p>
        )}
        {entries !== null && entries.length > 0 && (
          <div className="table-scroll" role="region" aria-label={heading} tabIndex={0}>
            <table className="settings-table">
              <thead>
                <tr>
                  <th scope="col">{t("auditTime")}</th>
                  <th scope="col">{t("auditWho")}</th>
                  <th scope="col">{t("auditActionColumn")}</th>
                  <th scope="col">{t("auditTargetColumn")}</th>
                  <th scope="col">{t("auditDetail")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const hasDetail =
                    typeof entry.detail === "object" &&
                    entry.detail !== null &&
                    Object.keys(entry.detail).length > 0;
                  return (
                    <tr key={entry.id}>
                      <td>
                        <time dateTime={entry.at}>{when.format(new Date(entry.at))}</time>
                      </td>
                      <td>
                        {entry.actorName ?? entry.actorId}
                        <br />
                        <small className="muted">{t(`auditActorKind_${entry.actorKind}`)}</small>
                      </td>
                      <td>
                        <code>{entry.action}</code>
                      </td>
                      <td>{entry.targetId ? <code>{entry.targetId}</code> : null}</td>
                      <td>
                        {hasDetail && (
                          <details>
                            <summary>{t("auditShowDetail")}</summary>
                            <pre className="audit-detail">
                              {JSON.stringify(entry.detail, null, 2)}
                            </pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {next && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              void load(applied, next);
            }}
          >
            {t("auditMore")}
          </button>
        )}
      </details>
    </section>
  );
}
