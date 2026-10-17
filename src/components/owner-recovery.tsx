"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowRight, Layers3, LoaderCircle } from "lucide-react";
import { z } from "zod";
// An owner who lost the password sets a new one: the secret of the deployment and a new password
// first, then a code of the authenticator or a backup code.
const startedSchema = z.object({ recoveryId: z.uuid() });
export function OwnerRecovery() {
  const t = useTranslations();
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [code, setCode] = useState("");
  const [recoveryId, setRecoveryId] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"start" | "code" | null>(null);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  const mismatch = repeat !== "" && repeat !== password;
  async function post(path: string, body: object): Promise<Response | null> {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
  }
  async function start(): Promise<void> {
    setBusy(true);
    setFailed(null);
    const response = await post("/api/recover/owner", { token, email, password });
    const parsed = response?.ok ? startedSchema.safeParse(await response.json()) : null;
    if (parsed?.success) setRecoveryId(parsed.data.recoveryId);
    else setFailed("start");
    setBusy(false);
  }
  async function confirm(): Promise<void> {
    if (!recoveryId) return;
    setBusy(true);
    setFailed(null);
    const response = await post("/api/recover/owner/confirm", {
      recoveryId,
      token,
      code: code.trim(),
    });
    if (response?.ok) {
      setToken("");
      setPassword("");
      setRepeat("");
      setDone(true);
    } else {
      setCode("");
      setFailed("code");
    }
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
        <h1>{t("recoverTitle")}</h1>
        {done ? (
          <>
            <p role="status">{t("recoverDone")}</p>
            <a className="primary" href="/login">
              {t("goToSignIn")}
            </a>
          </>
        ) : recoveryId ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            <fieldset disabled={!hydrated}>
              <p>{t("recoverCodeHint")}</p>
              <label>
                {t("recoverCode")}
                <input
                  value={code}
                  autoComplete="one-time-code"
                  onChange={(event) => {
                    setCode(event.target.value);
                  }}
                  required
                />
              </label>
              {failed === "code" && (
                <p className="error" role="alert">
                  {t("recoverCodeError")}
                </p>
              )}
              <button className="primary" type="submit" disabled={busy || !code.trim()}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
                {t("recoverConfirm")}
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
              <p className="muted">{t("recoverHint")}</p>
              <label>
                {t("recoveryToken")}
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
                {t("recoverNewPassword")}
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
              <label>
                {t("passwordRepeat")}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={repeat}
                  aria-invalid={mismatch}
                  onChange={(event) => {
                    setRepeat(event.target.value);
                  }}
                  required
                />
              </label>
              <p className="muted">{t("passwordHint")}</p>
              {mismatch && (
                <p className="error" role="alert">
                  {t("passwordMismatch")}
                </p>
              )}
              {failed === "start" && (
                <p className="error" role="alert">
                  {t("recoverStartError")}
                </p>
              )}
              <button
                className="primary"
                type="submit"
                disabled={busy || mismatch || repeat === "" || !token || !email || !password}
              >
                {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}
                {t("recoverContinue")}
              </button>
            </fieldset>
          </form>
        )}
      </section>
      <div className="login-orbit" aria-hidden="true" />
    </main>
  );
}
