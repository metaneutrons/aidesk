"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
// The identity providers of the installation, for its owner: registered, proved by their domain, tested, switched off
// and on, edited and deleted. The secret of a client is written once and never shown again.
const recordSchema = z.object({ name: z.string(), value: z.string() });
const providerSchema = z.object({
  providerId: z.string(),
  type: z.enum(["oidc", "saml"]),
  issuer: z.string(),
  domain: z.string(),
  domainVerified: z.boolean(),
  disabled: z.boolean(),
  callback: z.string(),
  metadata: z.string().nullable(),
  operators: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })),
});
type Provider = z.infer<typeof providerSchema>;
const checkedSchema = providerSchema.extend({
  result: z.enum(["verified", "record_missing", "request_first", "already_verified"]),
});
const testSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
});
type Message =
  | "registered"
  | "updated"
  | "verified"
  | "record_missing"
  | "request_first"
  | "tested"
  | "disabled"
  | "enabled"
  | "deleted"
  | "taken"
  | "error";
export function SsoProviders() {
  const t = useTranslations();
  const titleId = useId();
  const [rows, setRows] = useState<Provider[] | null>(null);
  const [records, setRecords] = useState<Record<string, z.infer<typeof recordSchema>>>({});
  const [tests, setTests] = useState<Record<string, z.infer<typeof testSchema>>>({});
  const [message, setMessage] = useState<{ text: Message; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"oidc" | "saml">("oidc");
  const [form, setForm] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const response = await fetch("/api/v1/sso-providers").catch(() => null);
    const parsed = response?.ok ? z.array(providerSchema).safeParse(await response.json()) : null;
    if (parsed?.success) setRows(parsed.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function call(
    id: string,
    path: string,
    method: "POST" | "PUT",
    body: unknown,
    done: (response: Response) => Promise<Message>,
  ) {
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/v1/sso-providers${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    const text: Message = response ? await done(response) : "error";
    setMessage({ text, id });
    await load();
    setBusy(false);
  }
  const field = (key: string, label: string, options: { type?: string; area?: boolean } = {}) => (
    <label key={key}>
      <span>{label}</span>
      {options.area ? (
        <textarea
          rows={4}
          value={form[key] ?? ""}
          spellCheck={false}
          onChange={(event) => {
            setForm({ ...form, [key]: event.target.value });
          }}
        />
      ) : (
        <input
          type={options.type ?? "text"}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={form[key] ?? ""}
          onChange={(event) => {
            setForm({ ...form, [key]: event.target.value });
          }}
        />
      )}
    </label>
  );
  if (rows === null) return null;
  const status = (row: Provider) =>
    row.disabled ? "ssoOff" : row.domainVerified ? "ssoVerified" : "ssoPending";
  return (
    <section className="connections sso-providers" aria-labelledby={`${titleId}-title`}>
      <h3 id={`${titleId}-title`}>{t("ssoTitle")}</h3>
      <p className="muted">{t("ssoHint")}</p>
      {rows.length === 0 ? (
        <p className="muted">{t("ssoNone")}</p>
      ) : (
        <ul className="connection-list">
          {rows.map((row) => (
            <li key={row.providerId}>
              <span>
                <strong>{row.providerId}</strong>{" "}
                <span className="muted">
                  {row.type.toUpperCase()}, {row.domain}
                </span>{" "}
                <span className={row.domainVerified && !row.disabled ? "muted" : "attention"}>
                  {t(status(row))}
                </span>
                <br />
                <small className="muted">
                  {row.type === "oidc" ? t("ssoCallback") : t("ssoMetadata")}:{" "}
                  <code>{row.type === "oidc" ? row.callback : (row.metadata ?? row.callback)}</code>
                </small>
                <br />
                <small className="muted">
                  {row.operators.length === 0
                    ? t("ssoNoOperators")
                    : t("ssoOperators", {
                        names: row.operators
                          .map((person) => `${person.name} (${person.email})`)
                          .join(", "),
                      })}
                </small>
                {records[row.providerId] && (
                  <>
                    <br />
                    <small>
                      {t("ssoRecord")} <code>{records[row.providerId]?.name}</code> TXT{" "}
                      <code>{records[row.providerId]?.value}</code>
                    </small>
                  </>
                )}
                {tests[row.providerId] && (
                  <ul className="sso-checks">
                    {tests[row.providerId]?.checks.map((check) => (
                      <li key={check.name} className={check.ok ? "muted" : "attention"}>
                        {check.ok ? t("ssoCheckOk") : t("ssoCheckFailed")} {check.name}:{" "}
                        {check.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </span>
              <span className="connection-actions">
                {!row.domainVerified && !row.disabled && (
                  <>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        void call(
                          row.providerId,
                          `/${row.providerId}/domain-record`,
                          "POST",
                          {},
                          async (response) => {
                            const parsed = response.ok
                              ? z
                                  .object({ record: recordSchema.nullable() })
                                  .safeParse(await response.json())
                              : null;
                            if (parsed?.success && parsed.data.record)
                              setRecords({ ...records, [row.providerId]: parsed.data.record });
                            return parsed?.success ? "request_first" : "error";
                          },
                        );
                      }}
                    >
                      {t("ssoShowRecord", { id: row.providerId })}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        void call(
                          row.providerId,
                          `/${row.providerId}/verify-domain`,
                          "POST",
                          {},
                          async (response) => {
                            const parsed = response.ok
                              ? checkedSchema.safeParse(await response.json())
                              : null;
                            if (parsed?.success)
                              return parsed.data.result === "already_verified"
                                ? "verified"
                                : parsed.data.result;
                            return "error";
                          },
                        );
                      }}
                    >
                      {t("ssoVerify", { id: row.providerId })}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    void call(
                      row.providerId,
                      `/${row.providerId}/test`,
                      "POST",
                      {},
                      async (response) => {
                        const parsed = response.ok
                          ? testSchema.safeParse(await response.json())
                          : null;
                        if (parsed?.success) setTests({ ...tests, [row.providerId]: parsed.data });
                        return parsed?.success ? "tested" : "error";
                      },
                    );
                  }}
                >
                  {t("ssoTest", { id: row.providerId })}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    const action = row.disabled ? "enable" : "disable";
                    void call(
                      row.providerId,
                      `/${row.providerId}/${action}`,
                      "POST",
                      {},
                      (response) =>
                        Promise.resolve(
                          response.ok ? (row.disabled ? "enabled" : "disabled") : "error",
                        ),
                    );
                  }}
                >
                  {t(row.disabled ? "ssoSwitchOn" : "ssoSwitchOff", { id: row.providerId })}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setEditing(editing === row.providerId ? null : row.providerId);
                    setEdit({});
                  }}
                >
                  {t("ssoEdit", { id: row.providerId })}
                </button>
              </span>
              {editing === row.providerId && (
                <form
                  className="sso-edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const body: Record<string, string> = {};
                    if (edit.domain?.trim()) body.domain = edit.domain.trim();
                    if (edit.clientSecret) body.clientSecret = edit.clientSecret;
                    void call(row.providerId, `/${row.providerId}`, "PUT", body, (response) => {
                      if (response.ok) {
                        setEditing(null);
                        return Promise.resolve("updated");
                      }
                      return Promise.resolve(response.status === 409 ? "taken" : "error");
                    });
                  }}
                >
                  <label>
                    <span>{t("ssoDomain")}</span>
                    <input
                      type="text"
                      placeholder={row.domain}
                      value={edit.domain ?? ""}
                      onChange={(event) => {
                        setEdit({ ...edit, domain: event.target.value });
                      }}
                    />
                  </label>
                  {row.type === "oidc" && (
                    <label>
                      <span>{t("ssoNewSecret")}</span>
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={edit.clientSecret ?? ""}
                        onChange={(event) => {
                          setEdit({ ...edit, clientSecret: event.target.value });
                        }}
                      />
                    </label>
                  )}
                  <button
                    type="submit"
                    className="primary"
                    disabled={busy || (!edit.domain && !edit.clientSecret)}
                  >
                    {t("ssoSaveChanges")}
                  </button>
                </form>
              )}
              <form
                className="sso-delete"
                onSubmit={(event) => {
                  event.preventDefault();
                  void call(
                    row.providerId,
                    `/${row.providerId}/delete`,
                    "POST",
                    { confirm: typed[row.providerId] ?? "" },
                    (response) => Promise.resolve(response.ok ? "deleted" : "error"),
                  );
                }}
              >
                <label>
                  <span>{t("ssoDeleteType", { id: row.providerId })}</span>
                  <input
                    type="text"
                    autoComplete="off"
                    value={typed[row.providerId] ?? ""}
                    onChange={(event) => {
                      setTyped({ ...typed, [row.providerId]: event.target.value });
                    }}
                  />
                </label>
                <button
                  type="submit"
                  className="secondary danger"
                  disabled={busy || (typed[row.providerId] ?? "") !== row.providerId}
                >
                  {t("ssoDelete", { id: row.providerId })}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <details className="sso-register">
        <summary>{t("ssoRegisterTitle")}</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const body =
              kind === "oidc"
                ? {
                    providerId: form.providerId?.trim(),
                    issuer: form.issuer?.trim(),
                    domain: form.domain?.trim(),
                    oidc: {
                      clientId: form.clientId?.trim(),
                      clientSecret: form.clientSecret,
                      ...(form.discoveryEndpoint?.trim()
                        ? { discoveryEndpoint: form.discoveryEndpoint.trim() }
                        : {}),
                    },
                  }
                : {
                    providerId: form.providerId?.trim(),
                    issuer: form.issuer?.trim(),
                    domain: form.domain?.trim(),
                    saml: {
                      entryPoint: form.entryPoint?.trim(),
                      cert: form.cert,
                      ...(form.audience?.trim() ? { audience: form.audience.trim() } : {}),
                    },
                  };
            void call(form.providerId ?? "", "", "POST", body, async (response) => {
              if (!response.ok) return response.status === 409 ? "taken" : "error";
              const parsed = z
                .object({ providerId: z.string(), domainRecord: recordSchema.nullable() })
                .safeParse(await response.json());
              if (parsed.success && parsed.data.domainRecord)
                setRecords({ ...records, [parsed.data.providerId]: parsed.data.domainRecord });
              setForm({});
              return "registered";
            });
          }}
        >
          <fieldset disabled={busy}>
            <legend>{t("ssoKind")}</legend>
            {(["oidc", "saml"] as const).map((value) => (
              <label key={value} className="configuration-check">
                <input
                  type="radio"
                  name="sso-kind"
                  checked={kind === value}
                  onChange={() => {
                    setKind(value);
                  }}
                />
                {value.toUpperCase()}
              </label>
            ))}
          </fieldset>
          {field("providerId", t("ssoProviderId"))}
          {field("issuer", t("ssoIssuer"))}
          {field("domain", t("ssoDomain"))}
          {kind === "oidc" ? (
            <>
              {field("clientId", t("ssoClientId"))}
              {field("clientSecret", t("ssoClientSecret"), { type: "password" })}
              {field("discoveryEndpoint", t("ssoDiscovery"))}
            </>
          ) : (
            <>
              {field("entryPoint", t("ssoEntryPoint"))}
              {field("cert", t("ssoCertificate"), { area: true })}
              {field("audience", t("ssoAudience"))}
            </>
          )}
          <button
            type="submit"
            className="primary"
            disabled={busy || !form.providerId || !form.issuer || !form.domain}
          >
            {t("ssoRegister")}
          </button>
        </form>
      </details>
      {message && (
        <p
          className={
            [
              "registered",
              "updated",
              "verified",
              "tested",
              "disabled",
              "enabled",
              "deleted",
            ].includes(message.text)
              ? "muted"
              : "error"
          }
          role="status"
        >
          {t(`ssoMessage_${message.text}`, { id: message.id })}
        </p>
      )}
    </section>
  );
}
