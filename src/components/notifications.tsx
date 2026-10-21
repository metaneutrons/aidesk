"use client";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { notificationPage } from "../domain/notifications";
// What the signed-in operator was told about: a new ticket, an assignment, a note that names them, an overdue
// ticket and a draft of an agent that waits. The entry holds the kind, the ticket number and the subject, and a click
// opens the ticket.
type Page = z.infer<typeof notificationPage>;
export function Notifications({
  locale,
  onOpen,
  onUnread,
}: {
  locale: string;
  onOpen: (ticketId: string) => void;
  onUnread: (unread: number) => void;
}) {
  const t = useTranslations();
  const titleId = useId();
  const [items, setItems] = useState<Page["notifications"] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [failed, setFailed] = useState(false);
  // Counts the reasons to load the first page again; the load always uses the filter that is shown now.
  const [version, setVersion] = useState(0);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const load = useCallback(
    async (cursor: string | null, only: boolean) => {
      const query = new URLSearchParams({ limit: "30" });
      if (only) query.set("unread", "true");
      if (cursor) query.set("before", cursor);
      const response = await fetch(`/api/v1/me/notifications?${query.toString()}`).catch(
        () => null,
      );
      const parsed = response?.ok ? notificationPage.safeParse(await response.json()) : null;
      if (!parsed?.success) {
        setFailed(true);
        return null;
      }
      setFailed(false);
      onUnread(parsed.data.unread);
      return parsed.data;
    },
    [onUnread],
  );
  // The answer of a load that was started before the filter changed is dropped.
  useEffect(() => {
    const run = { current: true };
    void load(null, unreadOnly).then((page) => {
      if (page && run.current) {
        setItems(page.notifications);
        setNext(page.next);
      }
    });
    return () => {
      run.current = false;
    };
  }, [load, unreadOnly, version]);
  async function read(ids?: string[]): Promise<void> {
    await fetch("/api/v1/me/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ids ? { ids } : {}),
    }).catch(() => null);
    setVersion((current) => current + 1);
  }
  return (
    <section className="connections notifications" aria-labelledby={`${titleId}-title`}>
      <h2 id={`${titleId}-title`} className="eyebrow">
        {t("notificationsTitle")}
      </h2>
      <div className="row-actions">
        <label className="inline-check">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(event) => {
              setUnreadOnly(event.target.checked);
            }}
          />
          {t("notificationsUnreadOnly")}
        </label>
        <button
          className="secondary"
          type="button"
          onClick={() => {
            void read();
          }}
        >
          {t("notificationsReadAll")}
        </button>
      </div>
      {failed && (
        <p className="error" role="alert">
          {t("error")}
        </p>
      )}
      {items === null ? (
        <p className="muted">{t("loading")}</p>
      ) : items.length === 0 ? (
        <p className="muted">{t("notificationsEmpty")}</p>
      ) : (
        <ul className="notification-list">
          {items.map((item) => (
            <li key={item.id} className={item.readAt ? "read" : "unread"}>
              <button
                type="button"
                className="notification-item"
                disabled={item.ticketId === null}
                onClick={() => {
                  if (!item.ticketId) return;
                  if (!item.readAt)
                    void fetch("/api/v1/me/notifications/read", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ ids: [item.id] }),
                    }).catch(() => null);
                  onOpen(item.ticketId);
                }}
              >
                <strong>{t(`notificationKind_${item.kind}`)}</strong>
                <span>
                  {item.ticketNumber === null ? "" : `#${String(item.ticketNumber)} `}
                  {item.subject ?? ""}
                </span>
                <small className="muted">
                  {item.projectName} · {when.format(new Date(item.createdAt))}
                </small>
              </button>
              {!item.readAt && (
                <button
                  className="icon-button"
                  type="button"
                  aria-label={t("notificationsMarkRead")}
                  onClick={() => {
                    void read([item.id]);
                  }}
                >
                  ✓
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {next && (
        <button
          className="secondary"
          type="button"
          onClick={() => {
            void load(next, unreadOnly).then((page) => {
              if (page) {
                setItems((current) => [...(current ?? []), ...page.notifications]);
                setNext(page.next);
              }
            });
          }}
        >
          {t("showMore")}
        </button>
      )}
    </section>
  );
}
