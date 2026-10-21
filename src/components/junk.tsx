"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { useZone } from "./time-zone";
const itemSchema = z.object({
  kind: z.enum(["ticket", "mail"]),
  id: z.uuid(),
  projectId: z.uuid(),
  subject: z.string(),
  from: z.string(),
  at: z.string(),
  reason: z.string(),
  canRestore: z.boolean(),
  mailbox: z.string().nullable(),
});
const mailSchema = z.object({
  subject: z.string(),
  from: z.string(),
  receivedAt: z.string(),
  reason: z.string(),
  attachments: z.number(),
  html: z.string(),
});
const ticketSchema = z.object({
  ticket: z.object({ subject: z.string(), requesterEmail: z.string() }),
  messages: z.array(z.object({ id: z.string(), authorName: z.string(), html: z.string() })),
});
type Item = z.infer<typeof itemSchema>;
interface Preview {
  subject: string;
  from: string;
  html: string[];
}
const mailboxStates: Record<string, string> = {
  pending: "junkMailboxPending",
  retrying: "junkMailboxPending",
  done: "junkMailboxDone",
  failed: "junkMailboxFailed",
};
const reasons: Record<string, string> = {
  operator: "junkReasonOperator",
  spam_flag: "junkReasonSpamFilter",
  spam_status: "junkReasonSpamFilter",
  advertising: "junkReasonAdvertising",
  phishing: "junkReasonPhishing",
  newsletter: "junkReasonNewsletter",
  automated: "junkReasonAutomated",
  other: "junkReasonAiOther",
  blocked_sender: "junkReasonBlockedSender",
  bulk_mail: "junkReasonBulk",
};
// Junk: tickets moved there by a person and mail classified as junk on
// arrival. Neither appears in the inbox until it is restored here.
export function Junk({
  projects,
  locale,
  onRestored,
}: {
  projects: { id: string; name: string }[];
  locale: string;
  onRestored: () => void;
}) {
  const t = useTranslations();
  const zone = useZone();
  const [items, setItems] = useState<Item[] | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/v1/junk").catch(() => null);
    const parsed = response?.ok ? z.array(itemSchema).safeParse(await response.json()) : null;
    if (parsed?.success) setItems(parsed.data);
    else setFailed(true);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function open(item: Item) {
    setSelected(item);
    setPreview(null);
    const response = await fetch(
      item.kind === "mail" ? `/api/v1/junk/${item.id}` : `/api/v1/tickets/${item.id}`,
    ).catch(() => null);
    const body: unknown = response?.ok ? await response.json() : null;
    if (item.kind === "mail") {
      const mail = mailSchema.safeParse(body);
      if (mail.success)
        setPreview({ subject: mail.data.subject, from: mail.data.from, html: [mail.data.html] });
      else setFailed(true);
    } else {
      const ticket = ticketSchema.safeParse(body);
      if (ticket.success)
        setPreview({
          subject: ticket.data.ticket.subject,
          from: ticket.data.ticket.requesterEmail,
          html: ticket.data.messages.map((message) => message.html),
        });
      else setFailed(true);
    }
  }
  async function restore(item: Item) {
    const response = await fetch(
      item.kind === "mail"
        ? `/api/v1/junk/${item.id}/restore`
        : `/api/v1/tickets/${item.id}/restore`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ).catch(() => null);
    if (!response?.ok) {
      setFailed(true);
      return;
    }
    setSelected(null);
    setPreview(null);
    await load();
    onRestored();
  }
  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? "";
  return (
    <section className="junk" aria-label={t("junk")}>
      <div className="junk-list">
        {failed && (
          <p className="error" role="alert">
            {t("junkError")}
          </p>
        )}
        <p className="muted">{t("junkHint")}</p>
        {items === null ? (
          <p className="muted">{t("junkLoading")}</p>
        ) : items.length === 0 ? (
          <p className="muted">{t("junkEmpty")}</p>
        ) : (
          <ul>
            {items.map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                <button
                  type="button"
                  className={`ticket-row ${selected?.id === item.id ? "selected" : ""}`}
                  onClick={() => {
                    void open(item);
                  }}
                >
                  <span className="ticket-meta">
                    <span>{item.from}</span>
                    <time dateTime={item.at}>
                      {new Intl.DateTimeFormat(locale, {
                        ...zone,
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(item.at))}
                    </time>
                  </span>
                  <strong>{item.subject || t("noSubject")}</strong>
                  <span className="ticket-meta">
                    <span>{projectName(item.projectId)}</span>
                    <span>{t(reasons[item.reason] ?? "junkReasonClassified")}</span>
                  </span>
                  {item.mailbox && (
                    <span className="ticket-meta">
                      <span>{t(mailboxStates[item.mailbox] ?? "junkMailboxPending")}</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {selected && (
        <article className="junk-preview" aria-label={t("junkPreview")}>
          <header>
            <h2>{preview?.subject ?? selected.subject}</h2>
            <p>{preview?.from ?? selected.from}</p>
            {selected.canRestore && (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  void restore(selected);
                }}
              >
                {t("notJunk")}
              </button>
            )}
          </header>
          {preview === null ? (
            <p className="muted">{t("junkLoading")}</p>
          ) : (
            preview.html.map((html, index) => (
              <div key={index} className="prose" dangerouslySetInnerHTML={{ __html: html }} />
            ))
          )}
        </article>
      )}
    </section>
  );
}
