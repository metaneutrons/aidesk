"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
// The webhooks of one project: where events are sent, what happened to the last
// delivery, a test event and disabling. Defining a webhook, with its signing
// secret, is done through the API; the page never shows a secret.
const hookSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  status: z.enum(["active", "disabled"]),
  version: z.number(),
  lastDelivery: z
    .object({
      at: z.string(),
      event: z.string(),
      outcome: z.enum(["succeeded", "retry", "failed"]),
      responseStatus: z.number().nullable(),
      code: z.string().nullable(),
    })
    .nullable(),
});
type Hook = z.infer<typeof hookSchema>;
export function Webhooks({
  projectId,
  name,
  locale,
}: {
  projectId: string;
  name: string;
  locale: string;
}) {
  const t = useTranslations();
  const titleId = useId();
  const [rows, setRows] = useState<Hook[] | null>(null);
  const [message, setMessage] = useState<"error" | "webhookProposed" | "webhookPinged" | null>(
    null,
  );
  const load = useCallback(async () => {
    const response = await fetch(`/api/v1/projects/${projectId}/webhooks`).catch(() => null);
    const parsed = response?.ok ? z.array(hookSchema).safeParse(await response.json()) : null;
    if (parsed?.success) setRows(parsed.data);
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function run(row: Hook, action: "ping" | "disable") {
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${projectId}/webhooks/${row.id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "disable" ? { expectedVersion: row.version } : {}),
    }).catch(() => null);
    if (!response?.ok) setMessage("error");
    else
      setMessage(
        action === "ping" ? "webhookPinged" : response.status === 202 ? "webhookProposed" : null,
      );
    await load();
  }
  if (rows === null) return null;
  return (
    <section className="connections" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("webhooksTitle", { project: name })}</h3>
      <p className="muted">{t("webhooksHint")}</p>
      {rows.length === 0 ? (
        <p className="muted">{t("webhooksNone")}</p>
      ) : (
        <ul className="connection-list">
          {rows.map((row) => (
            <li key={row.id}>
              <span>
                <strong>{row.name}</strong> <span className="muted">{row.url}</span>
                <br />
                <small className="muted">{row.events.join(", ")}</small>
              </span>
              <span className={row.lastDelivery?.outcome === "failed" ? "attention" : "muted"}>
                {row.status === "disabled"
                  ? t("webhookDisabled")
                  : row.lastDelivery
                    ? t(`webhookDelivery_${row.lastDelivery.outcome}`, {
                        date: new Intl.DateTimeFormat(locale, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(row.lastDelivery.at)),
                        code: row.lastDelivery.code ?? "",
                      })
                    : t("webhookNoDelivery")}
              </span>
              <span className="connection-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={row.status === "disabled"}
                  onClick={() => {
                    void run(row, "ping");
                  }}
                >
                  {t("webhookPing", { name: row.name })}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={row.status === "disabled"}
                  onClick={() => {
                    void run(row, "disable");
                  }}
                >
                  {t("webhookDisable", { name: row.name })}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p className={message === "error" ? "error" : "muted"} role="status">
          {t(message)}
        </p>
      )}
    </section>
  );
}
