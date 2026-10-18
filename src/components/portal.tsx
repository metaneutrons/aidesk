"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
interface PortalView {
  ticket: { number: number; subject: string; status: string; language: string; createdAt: string };
  canReply: boolean;
  messages: {
    id: string;
    from: "you" | "team";
    authorName: string;
    html: string;
    // A machine translation into the language of the page, when there is one.
    translation: string | null;
    attachments: { filename: string; size: number }[];
    createdAt: string;
  }[];
}
// The customer's view of one ticket: the public conversation and a reply form.
// Without a valid view the page only says that the link does not work, the same
// for every reason (unknown, expired, revoked).
const formatBytes = (size: number): string =>
  size < 1024
    ? `${String(size)} B`
    : size < 1_048_576
      ? `${String(Math.round(size / 1024))} kB`
      : `${(size / 1_048_576).toFixed(1)} MB`;
export interface PortalBrand {
  name: string | null;
  headerText: string | null;
  accent: string | null;
  accentText: string | null;
  hasLogo: boolean;
}
export function Portal({
  token,
  locale,
  view,
  fileLimits,
  brand,
}: {
  token: string;
  locale: string;
  brand: PortalBrand | null;
  view: PortalView | null;
  fileLimits: { count: number; mib: number };
}) {
  const t = useTranslations();
  const router = useRouter();
  const [text, setText] = useState("");
  const [state, setState] = useState<
    "idle" | "sending" | "failed" | "closed" | "limited" | "blocked" | "large" | "many"
  >("idle");
  const [files, setFiles] = useState<File[]>([]);
  // One key per attempt, kept until the reply was accepted, so a repeated
  // submission cannot create the message twice.
  const [key, setKey] = useState(() => crypto.randomUUID());
  // Until hydration the field is server HTML without handlers; a submit would
  // reload the page, and React would replace anything typed with the initial state.
  // Keep the field and the button disabled until then.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  if (!view)
    return (
      <main className="portal">
        <h1>{t("portalInvalidTitle")}</h1>
        <p>{t("portalInvalid")}</p>
      </main>
    );
  const format = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  async function submit() {
    setState("sending");
    const form = new FormData();
    form.set("token", token);
    form.set("markdown", text);
    form.set("idempotencyKey", key);
    for (const file of files) form.append("files", file);
    const response = await fetch("/api/portal/reply", {
      method: "POST",
      ...(files.length === 0
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token, markdown: text, idempotencyKey: key }),
          }
        : { body: form }),
    }).catch(() => null);
    if (response?.ok) {
      setText("");
      setFiles([]);
      setKey(crypto.randomUUID());
      setState("idle");
      router.refresh();
      return;
    }
    const code = response
      ? ((await response.json().catch(() => null)) as { error?: string } | null)?.error
      : undefined;
    setState(
      code === "attachment_type_blocked"
        ? "blocked"
        : code === "attachment_too_large"
          ? "large"
          : code === "attachment_count_exceeded"
            ? "many"
            : response?.status === 409
              ? "closed"
              : response?.status === 429
                ? "limited"
                : "failed",
    );
  }
  const branded =
    brand !== null && (brand.name !== null || brand.headerText !== null || brand.hasLogo);
  return (
    <main
      className="portal"
      style={
        brand?.accent && brand.accentText
          ? ({
              "--portal-accent": brand.accent,
              "--portal-on-accent": brand.accentText,
            } as React.CSSProperties)
          : undefined
      }
    >
      {branded && (
        <div className="portal-brand">
          {brand.hasLogo && (
            // The logo is the project's own image; its size is not known, so the page limits it in CSS.
            <img src={`/api/portal/logo/${token}`} alt="" height={48} />
          )}
          <div>
            {brand.name && <strong>{brand.name}</strong>}
            {brand.headerText && <p className="muted">{brand.headerText}</p>}
          </div>
        </div>
      )}
      <header>
        <p className="eyebrow">{t("portalRequest", { number: view.ticket.number })}</p>
        <h1>{view.ticket.subject}</h1>
        <p className="muted">
          <span className="status-badge">{t(view.ticket.status)}</span>
        </p>
      </header>
      <section aria-label={t("portalConversation")} className="portal-messages">
        {view.messages.map((message) => (
          <article key={message.id} className={message.from === "you" ? "own" : "team"}>
            <header>
              <strong>{message.from === "you" ? t("portalYou") : message.authorName}</strong>
              {/* The server writes the time in UTC and the browser in its own zone: the browser's wins. */}
              <time dateTime={message.createdAt} suppressHydrationWarning>
                {format.format(new Date(message.createdAt))}
              </time>
            </header>
            <div className="prose" dangerouslySetInnerHTML={{ __html: message.html }} />
            {message.attachments.length > 0 && (
              <ul className="attachments" aria-label={t("portalAttachments")}>
                {message.attachments.map((file, index) => (
                  <li key={`${file.filename}:${String(index)}`}>
                    {file.filename} <small>{formatBytes(file.size)}</small>
                  </li>
                ))}
              </ul>
            )}
            {message.translation !== null && (
              <section className="translation" aria-label={t("portalTranslation")}>
                <small className="muted">{t("portalTranslation")}</small>
                <div className="prose" dangerouslySetInnerHTML={{ __html: message.translation }} />
              </section>
            )}
          </article>
        ))}
      </section>
      {view.canReply ? (
        <form
          className="portal-reply"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="portal-text">{t("portalReply")}</label>
          <textarea
            id="portal-text"
            value={text}
            rows={6}
            maxLength={20000}
            required
            disabled={!hydrated}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
          <label htmlFor="portal-files">{t("portalAttach")}</label>
          <input
            id="portal-files"
            type="file"
            multiple
            disabled={!hydrated}
            onChange={(event) => {
              setFiles([...(event.target.files ?? [])]);
            }}
          />
          <small className="muted">
            {t("portalAttachHint", { count: fileLimits.count, size: fileLimits.mib })}
          </small>
          {files.length > 0 && <p role="status">{t("portalAttached", { count: files.length })}</p>}
          <button
            className="primary"
            type="submit"
            disabled={!hydrated || state === "sending" || !text.trim()}
          >
            {t("portalSend")}
          </button>
          {state !== "idle" && state !== "sending" && (
            <p className="error" role="alert">
              {t(
                state === "closed"
                  ? "portalClosed"
                  : state === "limited"
                    ? "portalLimited"
                    : state === "blocked"
                      ? "portalAttachBlocked"
                      : state === "large"
                        ? "portalAttachLarge"
                        : state === "many"
                          ? "portalAttachMany"
                          : "portalFailed",
              )}
            </p>
          )}
        </form>
      ) : (
        <p className="muted">{t("portalClosed")}</p>
      )}
    </main>
  );
}
