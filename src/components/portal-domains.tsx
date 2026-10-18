"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
// The names under which the customer page of one project is reached next to the shared address. A name is
// claimed here, proved with a text record in the DNS (the page shows the record to create), and checked
// again as often as needed. A name serves the page only after it is verified.
const domainSchema = z.object({
  id: z.string(),
  host: z.string(),
  verified: z.boolean(),
  challenge: z.object({ name: z.string(), value: z.string() }),
});
const checkedSchema = domainSchema.extend({
  result: z.enum(["verified", "record_missing", "dns_error"]),
});
type Domain = z.infer<typeof domainSchema>;
type Message =
  "added" | "removed" | "verified" | "record_missing" | "dns_error" | "taken" | "error";
export function PortalDomains({ projectId, name }: { projectId: string | null; name: string }) {
  const t = useTranslations();
  const titleId = useId();
  const base = projectId
    ? `/api/v1/projects/${projectId}/portal-domains`
    : "/api/v1/portal-domains";
  const [rows, setRows] = useState<Domain[] | null>(null);
  const [host, setHost] = useState("");
  const [message, setMessage] = useState<{ text: Message; host: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch(base).catch(() => null);
    const parsed = response?.ok ? z.array(domainSchema).safeParse(await response.json()) : null;
    if (parsed?.success) setRows(parsed.data);
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  async function send(path: string, body: unknown, done: (response: Response) => Promise<Message>) {
    setBusy(true);
    setMessage(null);
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const text: Message = response ? await done(response) : "error";
    setMessage({ text, host: (body as { host?: string }).host ?? "" });
    await load();
    setBusy(false);
  }
  if (rows === null) return null;
  return (
    <section className="connections portal-domains" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>
        {projectId
          ? t("portalDomainsTitle", { project: name })
          : t("portalDomainsTitleInstallation")}
      </h3>
      <p className="muted">
        {t(projectId ? "portalDomainsHint" : "portalDomainsHintInstallation")}
      </p>
      {rows.length === 0 ? (
        <p className="muted">{t("portalDomainsNone")}</p>
      ) : (
        <ul className="connection-list">
          {rows.map((row) => (
            <li key={row.id}>
              <span>
                <strong>{row.host}</strong>{" "}
                <span className={row.verified ? "muted" : "attention"}>
                  {t(row.verified ? "portalDomainVerified" : "portalDomainPending")}
                </span>
                {!row.verified && (
                  <>
                    <br />
                    <small className="muted">{t("portalDomainRecord")}</small>
                    <br />
                    <small>
                      <code>{row.challenge.name}</code> TXT <code>{row.challenge.value}</code>
                    </small>
                  </>
                )}
              </span>
              <span className="connection-actions">
                {!row.verified && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      void send(`/${row.id}/verify`, { host: row.host }, async (response) => {
                        const parsed = response.ok
                          ? checkedSchema.safeParse(await response.json())
                          : null;
                        if (parsed?.success) return parsed.data.result;
                        return response.status === 409 ? "taken" : "error";
                      });
                    }}
                  >
                    {t("portalDomainVerify", { host: row.host })}
                  </button>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    void send(`/${row.id}/remove`, { host: row.host }, (response) =>
                      Promise.resolve(response.ok ? "removed" : "error"),
                    );
                  }}
                >
                  {t("portalDomainRemove", { host: row.host })}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="portal-domain-form"
        onSubmit={(event) => {
          event.preventDefault();
          const wanted = host.trim();
          void send("", { host: wanted }, (response) => {
            if (response.ok) {
              setHost("");
              return Promise.resolve("added");
            }
            return Promise.resolve(response.status === 409 ? "taken" : "error");
          });
        }}
      >
        <label>
          <span>{t("portalDomainHost")}</span>
          <input
            type="text"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={253}
            value={host}
            onChange={(event) => {
              setHost(event.target.value);
            }}
          />
        </label>
        <button type="submit" className="primary" disabled={busy || host.trim() === ""}>
          {t("portalDomainAdd")}
        </button>
      </form>
      <p className="muted">{t("portalDomainPoint")}</p>
      {message && (
        <p
          className={
            message.text === "added" || message.text === "removed" || message.text === "verified"
              ? "muted"
              : "error"
          }
          role="status"
        >
          {t(`portalDomainMessage_${message.text}`, { host: message.host })}
        </p>
      )}
    </section>
  );
}
