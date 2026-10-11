"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowRight, Layers3, LoaderCircle } from "lucide-react";
export function Login({ returnTo, development }: { returnTo: string; development: boolean }) {
  const t = useTranslations();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function signIn(sso: boolean): Promise<void> {
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/auth/sign-in/${sso ? "sso" : "email"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sso ? { email, callbackURL: returnTo } : { email, password }),
      });
      if (!response.ok) throw new Error("sign_in_failed");
      if (sso) {
        const data: unknown = await response.json();
        if (
          typeof data !== "object" ||
          data === null ||
          !("url" in data) ||
          typeof data.url !== "string"
        )
          throw new Error("invalid_sso_redirect");
        window.location.assign(data.url);
      } else {
        window.location.assign(returnTo);
      }
    } catch {
      setFailed(true);
      setBusy(false);
    }
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
        <div className="eyebrow">{development ? t("development") : "aidesk"}</div>
        <h1>{t("loginTitle")}</h1>
        <p className="muted">{t("loginDescription")}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void signIn(!development);
          }}
        >
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
          {development && (
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
          {failed && (
            <p className="error" role="alert">
              {t("loginError")}
            </p>
          )}
          {development && (
            <button className="primary" type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
              {t("signIn")}
            </button>
          )}
          <button
            className={development ? "secondary" : "primary"}
            type={development ? "button" : "submit"}
            disabled={busy || !email}
            onClick={
              development
                ? () => {
                    void signIn(true);
                  }
                : undefined
            }
          >
            {t("signInSso")}
          </button>
        </form>
        <p className="hint">{t(development ? "devLoginHint" : "ssoEmailHint")}</p>
      </section>
      <div className="login-orbit" aria-hidden="true" />
    </main>
  );
}
