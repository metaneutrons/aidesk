"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowRight, Layers3, LoaderCircle } from "lucide-react";
type Step = "credentials" | "code";
export function Login({
  returnTo,
  development,
  ssoFailed,
}: {
  returnTo: string;
  development: boolean;
  ssoFailed: boolean;
}) {
  const t = useTranslations();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>("credentials");
  // SSO is the normal way in; the password is the owners' recovery path.
  const [withPassword, setWithPassword] = useState(development);
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"login" | "code" | null>(null);
  // Until hydration the inputs are server HTML without handlers; React would
  // replace anything typed then with the initial state. Keep them disabled.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  async function post(path: string, body: object): Promise<Response> {
    return fetch(`/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function signIn(sso: boolean): Promise<void> {
    setBusy(true);
    setFailed(null);
    try {
      if (sso) {
        const response = await post("/sign-in/sso", {
          email,
          callbackURL: returnTo,
          errorCallbackURL: `/login?sso=failed&next=${encodeURIComponent(returnTo)}`,
        });
        if (!response.ok) throw new Error("sign_in_failed");
        const data: unknown = await response.json();
        if (typeof data !== "object" || data === null || !("url" in data))
          throw new Error("invalid_sso_redirect");
        if (typeof data.url !== "string") throw new Error("invalid_sso_redirect");
        window.location.assign(data.url);
        return;
      }
      const response = await post("/sign-in/email", { email, password });
      if (!response.ok) throw new Error("sign_in_failed");
      const data: unknown = await response.json();
      if (typeof data === "object" && data !== null && "twoFactorRedirect" in data) {
        setPassword("");
        setStep("code");
        setBusy(false);
        return;
      }
      window.location.assign(returnTo);
    } catch {
      setFailed("login");
      setBusy(false);
    }
  }
  async function verify(): Promise<void> {
    setBusy(true);
    setFailed(null);
    const response = await post(
      backup ? "/two-factor/verify-backup-code" : "/two-factor/verify-totp",
      { code: code.trim() },
    ).catch(() => null);
    if (response?.ok) {
      window.location.assign(returnTo);
      return;
    }
    setFailed("code");
    setBusy(false);
  }
  const loginError = (failed === "login" || (ssoFailed && failed === null)) && (
    <p className="error" role="alert">
      {t(ssoFailed && failed === null ? "ssoError" : "loginError")}
    </p>
  );
  return (
    <main className="login-shell">
      <div className="login-brand">
        <span className="brand-mark">
          <Layers3 size={22} />
        </span>
        aidesk
      </div>
      <section className="login-card">
        <div className="eyebrow">{development ? t("development") : "aidesk"}</div>
        <h1>{t("loginTitle")}</h1>
        {step === "code" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void verify();
            }}
          >
            <fieldset disabled={!hydrated}>
              <label>
                {t(backup ? "backupCode" : "totpCode")}
                <input
                  value={code}
                  inputMode={backup ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  onChange={(event) => {
                    setCode(event.target.value);
                  }}
                  required
                />
              </label>
              <p className="muted">{t(backup ? "backupHint" : "totpHint")}</p>
              {failed === "code" && (
                <p className="error" role="alert">
                  {t("codeError")}
                </p>
              )}
              <button className="primary" type="submit" disabled={busy || !code.trim()}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
                {t("verify")}
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setBackup(!backup);
                  setCode("");
                  setFailed(null);
                }}
              >
                {t(backup ? "useTotp" : "useBackupCode")}
              </button>
            </fieldset>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void signIn(!withPassword);
            }}
          >
            <fieldset disabled={!hydrated}>
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
              {withPassword && (
                <label>
                  {t("password")}
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                    }}
                    required
                  />
                </label>
              )}
              {loginError}
              {withPassword && (
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
                  {t("signIn")}
                </button>
              )}
              <button
                className={withPassword ? "secondary" : "primary"}
                type={withPassword ? "button" : "submit"}
                disabled={busy || !email}
                onClick={
                  withPassword
                    ? () => {
                        void signIn(true);
                      }
                    : undefined
                }
              >
                {t("signInSso")}
              </button>
              {!withPassword && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setWithPassword(true);
                  }}
                >
                  {t("ownerPassword")}
                </button>
              )}
            </fieldset>
          </form>
        )}
        <p className="hint">{t(development ? "devLoginHint" : "ssoEmailHint")}</p>
      </section>
      <div className="login-orbit" aria-hidden="true" />
    </main>
  );
}
