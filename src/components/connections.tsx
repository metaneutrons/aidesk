"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { ConnectionForm } from "./connection-form";
// The connections of one project: status, test and disable, and the form that defines or changes
// one. The form takes the secret; the page never shows one.
const connectionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  direction: z.enum(["inbound", "outbound", "ai", "knowledge"]),
  name: z.string(),
  status: z.enum(["draft", "ready", "degraded", "disabled"]),
  lastErrorCode: z.string().nullable(),
  version: z.number(),
  usedForOutgoingMail: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  secretSet: z.boolean(),
});
type Connection = z.infer<typeof connectionSchema>;
export function Connections({
  projectId,
  name,
  onChanged,
}: {
  projectId: string;
  name: string;
  onChanged: () => void;
}) {
  const t = useTranslations();
  const titleId = useId();
  const [rows, setRows] = useState<Connection[] | null>(null);
  const [message, setMessage] = useState<"error" | "connectionProposed" | null>(null);
  // The form that is open: a new connection, or the connection that is changed.
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(`/api/v1/projects/${projectId}/connections`).catch(() => null);
    const parsed = response?.ok ? z.array(connectionSchema).safeParse(await response.json()) : null;
    if (parsed?.success) setRows(parsed.data);
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function run(row: Connection, action: "test" | "disable") {
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${projectId}/connections/${row.id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "disable" ? { expectedVersion: row.version } : {}),
    }).catch(() => null);
    if (!response?.ok) setMessage("error");
    else if (response.status === 202) setMessage("connectionProposed");
    await load();
    onChanged();
  }
  if (rows === null) return null;
  return (
    <section className="connections" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("connectionsTitle", { project: name })}</h3>
      <p className="muted">{t("connectionsHint")}</p>
      {rows.length === 0 ? (
        <p className="muted">{t("connectionsNone")}</p>
      ) : (
        <ul className="connection-list">
          {rows.map((row) => (
            <li key={row.id}>
              <span>
                <strong>{row.name}</strong>{" "}
                <span className="muted">
                  {t(`connectionKind_${row.kind}`)} · {t(`connection_${row.direction}`)}
                </span>
                {row.usedForOutgoingMail && (
                  <span className="tag-chip">{t("connectionOutgoing")}</span>
                )}
              </span>
              <span className={row.status === "degraded" ? "attention" : "muted"}>
                {t(`connectionStatus_${row.status}`)}
                {row.lastErrorCode ? ` (${row.lastErrorCode})` : ""}
              </span>
              <span className="connection-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={row.status === "disabled"}
                  onClick={() => {
                    void run(row, "test");
                  }}
                >
                  {t("connectionTest", { name: row.name })}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={row.status === "disabled"}
                  onClick={() => {
                    setEditing(row);
                  }}
                >
                  {t("connEdit", { name: row.name })}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={row.status === "disabled"}
                  onClick={() => {
                    void run(row, "disable");
                  }}
                >
                  {t("connectionDisable", { name: row.name })}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing === null ? (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setEditing("new");
          }}
        >
          {t("connNew")}
        </button>
      ) : (
        <ConnectionForm
          key={editing === "new" ? "new" : editing.id}
          projectId={projectId}
          {...(editing === "new" ? {} : { existing: editing })}
          onDone={(proposed) => {
            setEditing(null);
            setMessage(proposed ? "connectionProposed" : null);
            void load();
            onChanged();
          }}
          onCancel={() => {
            setEditing(null);
          }}
        />
      )}
      {message && (
        <p className={message === "error" ? "error" : "muted"} role="status">
          {t(message)}
        </p>
      )}
    </section>
  );
}
