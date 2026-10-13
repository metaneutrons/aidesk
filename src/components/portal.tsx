"use client";
import { useState } from "react";
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
    createdAt: string;
  }[];
}
// The customer's view of one ticket: the public conversation and a reply form.
// Without a valid view the page only says that the link does not work, the same
// for every reason (unknown, expired, revoked).
export function Portal({
  token,
  locale,
  view,
}: {
  token: string;
  locale: string;
  view: PortalView | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "failed" | "closed" | "limited">("idle");
  // One key per attempt, kept until the reply was accepted, so a repeated
  // submission cannot create the message twice.
  const [key, setKey] = useState(() => crypto.randomUUID());
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
    const response = await fetch("/api/portal/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, markdown: text, idempotencyKey: key }),
    }).catch(() => null);
    if (response?.ok) {
      setText("");
      setKey(crypto.randomUUID());
      setState("idle");
      router.refresh();
      return;
    }
    setState(response?.status === 409 ? "closed" : response?.status === 429 ? "limited" : "failed");
  }
  return (
    <main className="portal">
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
              <time dateTime={message.createdAt}>{format.format(new Date(message.createdAt))}</time>
            </header>
            <div className="prose" dangerouslySetInnerHTML={{ __html: message.html }} />
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
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
          <button className="primary" type="submit" disabled={state === "sending" || !text.trim()}>
            {t("portalSend")}
          </button>
          {state !== "idle" && state !== "sending" && (
            <p className="error" role="alert">
              {t(
                state === "closed"
                  ? "portalClosed"
                  : state === "limited"
                    ? "portalLimited"
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
