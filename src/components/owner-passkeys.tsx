"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { startRegistration } from "@simplewebauthn/browser";
import { z } from "zod";
import { useZone } from "./time-zone";
// The passkeys of the owner who is signed in: the second factor after the password, in the place of the
// code of the authenticator app, which stays as the way back.
const listSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string().nullish(),
    createdAt: z.string().nullish(),
    backedUp: z.boolean().optional(),
  }),
);
type Message = "passkeyAdded" | "passkeyAddError" | "passkeyRemoved" | null;
export function OwnerPasskeys({ locale }: { locale: string }) {
  const t = useTranslations();
  const zone = useZone();
  const nameId = useId();
  const [passkeys, setPasskeys] = useState<z.infer<typeof listSchema> | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/auth/passkey/list-user-passkeys").catch(() => null);
    const parsed = response?.ok ? listSchema.safeParse(await response.json()) : null;
    setPasskeys(parsed?.success ? parsed.data : []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function add(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const label = name.trim() || t("passkeyDefaultName");
      const options = await fetch(
        `/api/auth/passkey/generate-register-options?name=${encodeURIComponent(label)}`,
      );
      if (!options.ok) throw new Error("options");
      const optionsJSON = (await options.json()) as Parameters<
        typeof startRegistration
      >[0]["optionsJSON"];
      const attestation = await startRegistration({ optionsJSON });
      const verified = await fetch("/api/auth/passkey/verify-registration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: attestation, name: label }),
      });
      if (!verified.ok) throw new Error("verify");
      setName("");
      setMessage("passkeyAdded");
    } catch {
      setMessage("passkeyAddError");
    }
    await load();
    setBusy(false);
  }
  async function remove(id: string): Promise<void> {
    setBusy(true);
    await fetch("/api/auth/passkey/delete-passkey", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => null);
    setMessage("passkeyRemoved");
    await load();
    setBusy(false);
  }
  if (passkeys === null) return null;
  return (
    <section className="passkeys" aria-labelledby={`${nameId}-title`}>
      <h3 id={`${nameId}-title`}>{t("passkeysTitle")}</h3>
      <p className="muted">{t("passkeysHint")}</p>
      {passkeys.length === 0 ? (
        <p className="muted">{t("passkeyNone")}</p>
      ) : (
        <ul className="token-list">
          {passkeys.map((entry) => {
            const label = entry.name ?? t("passkeyDefaultName");
            return (
              <li key={entry.id}>
                <strong>{label}</strong>
                {entry.createdAt && (
                  <span>
                    {t("passkeyCreated", {
                      date: new Intl.DateTimeFormat(locale, {
                        ...zone,
                        dateStyle: "medium",
                      }).format(new Date(entry.createdAt)),
                    })}
                  </span>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  aria-label={`${t("passkeyRemove")}: ${label}`}
                  onClick={() => {
                    void remove(entry.id);
                  }}
                >
                  {t("passkeyRemove")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label htmlFor={`${nameId}-name`}>{t("passkeyName")}</label>
        <input
          id={`${nameId}-name`}
          value={name}
          maxLength={60}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <button className="primary" type="submit" disabled={busy}>
          {t("passkeyAdd")}
        </button>
        {message && (
          <p className={message === "passkeyAddError" ? "error" : "muted"} role="status">
            {t(message)}
          </p>
        )}
      </form>
    </section>
  );
}
