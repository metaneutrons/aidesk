"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowRight, Layers3, LoaderCircle } from "lucide-react";
import { z } from "zod";
const claimSchema = z.object({
  claimId: z.uuid(),
  totpURI: z.string(),
  secret: z.string(),
  backupCodes: z.array(z.string()),
});
type Claim = z.infer<typeof claimSchema>;
export function OwnerSetup({ claimed }: { claimed: boolean }) {
  const t = useTranslations();
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [claim, setClaim] = useState<Claim | null>(null);
  const [done, setDone] = useState(claimed);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  async function post(path: string, body: object): Promise<Response | null> {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
  }
  async function start(): Promise<void> {
    setBusy(true);
    setFailed(false);
    const response = await post("/api/setup/owner", { token, name, email, password });
    const parsed = response?.ok ? claimSchema.safeParse(await response.json()) : null;
    if (parsed?.success) {
      setPassword("");
      setClaim(parsed.data);
    } else setFailed(true);
    setBusy(false);
  }
  async function confirm(): Promise<void> {
    if (!claim) return;
    setBusy(true);
    setFailed(false);
    const response = await post("/api/setup/owner/confirm", {
      claimId: claim.claimId,
      token,
      code: code.trim(),
    });
    if (response?.ok) {
      setToken("");
      setClaim(null);
      setDone(true);
    } else setFailed(true);
    setBusy(false);
  }
  return (
    <main className="login-shell">
      <div className="login-brand">
        <span className="brand-mark">
          <Layers3 size={22} />
        </span>
        aidesk
      </div>
      <section className="login-card">
        <h1>{t("setupTitle")}</h1>
        {done ? (
          <>
            <p role="status">{t(claimed ? "setupDone" : "setupComplete")}</p>
            <a className="primary" href="/login">
              {t("goToSignIn")}
            </a>
          </>
        ) : claim ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            <fieldset disabled={!hydrated}>
              <p>{t("setupSecret")}</p>
              <code className="setup-secret">{claim.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
              <a href={claim.totpURI}>{claim.totpURI.split("?")[0]}</a>
              <p>{t("setupBackupCodes")}</p>
              <ul className="backup-codes">
                {claim.backupCodes.map((backupCode) => (
                  <li key={backupCode}>
                    <code>{backupCode}</code>
                  </li>
                ))}
              </ul>
              <label>
                {t("totpCode")}
                <input
                  value={code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  onChange={(event) => {
                    setCode(event.target.value);
                  }}
                  required
                />
              </label>
              {failed && (
                <p className="error" role="alert">
                  {t("codeError")}
                </p>
              )}
              <button className="primary" type="submit" disabled={busy || !code.trim()}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
                {t("setupConfirm")}
              </button>
            </fieldset>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <fieldset disabled={!hydrated}>
              <label>
                {t("claimToken")}
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => {
                    setToken(event.target.value);
                  }}
                  required
                />
              </label>
              <p className="muted">{t("claimTokenHint")}</p>
              <label>
                {t("name")}
                <input
                  autoComplete="name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                  required
                />
              </label>
              <label>
                {t("email")}
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                  required
                />
              </label>
              <label>
                {t("password")}
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                  }}
                  required
                />
              </label>
              <p className="muted">{t("passwordHint")}</p>
              {failed && (
                <p className="error" role="alert">
                  {t("setupError")}
                </p>
              )}
              <button className="primary" type="submit" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
                {t("continue")}
              </button>
            </fieldset>
          </form>
        )}
      </section>
      <div className="login-orbit" aria-hidden="true" />
    </main>
  );
}
