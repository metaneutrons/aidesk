"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  Inbox,
  Layers3,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Search,
  Send,
  Settings as SettingsIcon,
  Sun,
  X,
} from "lucide-react";
import { z } from "zod";
import { Dialog } from "@base-ui/react/dialog";
import { responseState } from "../domain/response-clock";
import type { Locale } from "../domain/locale";
import { actions } from "../domain/permissions";
import { Settings } from "./settings";
const ticketSchema = z.object({
  id: z.uuid(),
  number: z.number().nullable(),
  projectId: z.uuid(),
  subject: z.string(),
  status: z.enum(["open", "waiting", "resolved"]),
  requesterName: z.string(),
  requesterEmail: z.string(),
  language: z.string(),
  revision: z.number(),
  pendingSince: z.string().nullable(),
  assigneeUserId: z.string().nullable(),
  assigneeAgentId: z.string().nullable(),
});
const messageSchema = z.object({
  id: z.uuid(),
  authorName: z.string(),
  authorType: z.string(),
  internal: z.boolean(),
  markdown: z.string(),
  html: z.string(),
  deliveryState: z.string(),
  deliveryError: z.string().nullable(),
  createdAt: z.string(),
});
// Why a reply needs checking. Codes without their own text keep the general
// one; each text says whether the mail was sent.
const deliveryErrors: Record<string, string> = {
  recipient_suppressed: "deliveryRecipientSuppressed",
  suppression_check_failed: "deliverySuppressionCheckFailed",
  transport_rejected: "deliveryRejected",
  recipient_not_accepted: "deliveryRejected",
  transport_acceptance_unknown: "deliveryUnknown",
  expired_dispatch_lease: "deliveryUnknown",
};
const addressSchema = z.object({ name: z.string(), address: z.string() });
const conversationSchema = z.object({
  ticket: ticketSchema,
  messages: z.array(messageSchema),
  actions: z.array(z.enum(actions)),
  sender: addressSchema.nullable(),
  recipients: z.array(addressSchema),
});
const mailbox = (entry: z.infer<typeof addressSchema>) => `${entry.name} <${entry.address}>`;
type Ticket = z.infer<typeof ticketSchema>;
interface Project {
  id: string;
  name: string;
  slug: string;
  color: string;
  defaultLanguage: string;
}
interface Props {
  projects: Project[];
  initialTickets: Ticket[];
  operator: { id: string; name: string; owner: boolean };
  initialTicketId: string | null;
  initialLocale: Locale;
  localePreference: string | null;
  serverTime: number;
}
type Theme = "system" | "light" | "dark";
const themes: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: "system", icon: Monitor, label: "themeSystem" },
  { value: "light", icon: Sun, label: "themeLight" },
  { value: "dark", icon: Moon, label: "themeDark" },
];
function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
type View = "overview" | "inbox" | "overdue" | "waiting" | "resolved" | "settings";
export function Desk({
  projects,
  initialTickets,
  operator,
  initialTicketId,
  initialLocale,
  localePreference,
  serverTime,
}: Props) {
  const t = useTranslations();
  const router = useRouter();
  const [, transition] = useTransition();
  const [view, setView] = useState<View>(initialTicketId ? "inbox" : "overview");
  const [filters, setFilters] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(initialTicketId);
  const [conversation, setConversation] = useState<z.infer<typeof conversationSchema> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [internal, setInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [now, setNow] = useState(serverTime);
  const [creating, setCreating] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [slug, setSlug] = useState("");
  const messageList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.lang = initialLocale;
  }, [initialLocale]);
  useEffect(() => {
    const stored = localStorage.getItem("aidesk:theme");
    const mode = stored === "light" || stored === "dark" ? stored : "system";
    setTheme(mode);
    applyTheme(mode);
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 60_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!selected) {
      setConversation(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDraft(localStorage.getItem(`aidesk:${operator.id}:${selected}:draft`) ?? "");
    setInternal(false);
    void fetch(`/api/v1/tickets/${selected}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("no_access");
        const body: unknown = await response.json();
        setConversation(conversationSchema.parse(body));
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setConversation(null);
          setError("noAccess");
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [selected, operator.id]);
  const messageCount = conversation?.messages.length ?? 0;
  useEffect(() => {
    const list = messageList.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [selected, messageCount]);
  // Delivery happens in the worker. While a reply is queued, refresh the
  // conversation until the transport outcome is recorded, then refresh the
  // server-rendered list so status and response clock follow.
  const queued = conversation?.messages.some((message) => message.deliveryState === "queued");
  useEffect(() => {
    if (!selected || !queued) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (attempts > 60) {
        window.clearInterval(timer);
        return;
      }
      void fetch(`/api/v1/tickets/${selected}`)
        .then(async (response) => {
          if (!response.ok) return;
          const next = conversationSchema.parse(await response.json());
          if (next.messages.some((message) => message.deliveryState === "queued")) return;
          window.clearInterval(timer);
          setConversation(next);
          transition(() => {
            router.refresh();
          });
        })
        .catch(() => undefined);
    }, 2_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [selected, queued, router]);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const scoped = initialTickets.filter(
    (ticket) =>
      (!filters.length || filters.includes(ticket.projectId)) &&
      `${ticket.subject} ${ticket.requesterName} ${ticket.requesterEmail}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const overdue = (ticket: Ticket) =>
    ticket.pendingSince !== null &&
    responseState(
      { receivedAt: new Date(ticket.pendingSince), answeredAt: null },
      new Date(now),
    ) === "overdue";
  const visible = scoped.filter((ticket) =>
    view === "overdue"
      ? overdue(ticket)
      : view === "waiting"
        ? ticket.status === "waiting"
        : view === "resolved"
          ? ticket.status === "resolved"
          : ticket.status !== "resolved",
  );
  function age(ticket: Ticket): string {
    if (!ticket.pendingSince) return t(ticket.status);
    const minutes = Math.max(
      0,
      Math.floor((now - new Date(ticket.pendingSince).getTime()) / 60_000),
    );
    return minutes < 60
      ? t("minutes", { count: minutes })
      : minutes < 1440
        ? t("hours", { count: Math.floor(minutes / 60) })
        : t("days", { count: Math.floor(minutes / 1440) });
  }
  function select(ticketId: string) {
    setSelected(ticketId);
    setView("inbox");
    window.history.replaceState(null, "", `/?ticket=${ticketId}`);
  }
  function editDraft(value: string) {
    setDraft(value);
    if (selected) localStorage.setItem(`aidesk:${operator.id}:${selected}:draft`, value);
  }
  async function send(): Promise<void> {
    if (!conversation || !selected || !draft.trim()) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/tickets/${selected}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          markdown: draft,
          internal,
          language: conversation.ticket.language,
          expectedRevision: conversation.ticket.revision,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      if (!response.ok) {
        setError(response.status === 409 ? "conflict" : "error");
        return;
      }
      editDraft("");
      const fresh = await fetch(`/api/v1/tickets/${selected}`);
      if (!fresh.ok) throw new Error("refresh_failed");
      const body: unknown = await fresh.json();
      setConversation(conversationSchema.parse(body));
      transition(() => {
        router.refresh();
      });
    } catch {
      setError("error");
    } finally {
      setSending(false);
    }
  }
  async function create(): Promise<void> {
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: projectName, slug, defaultLanguage: initialLocale }),
      });
      if (!response.ok) throw new Error("create_failed");
      setCreating(false);
      setProjectName("");
      setSlug("");
      router.refresh();
    } catch {
      setError("error");
    } finally {
      setSending(false);
    }
  }
  const navigation: { view: View; icon: typeof Inbox }[] = [
    { view: "overview", icon: LayoutDashboard },
    { view: "inbox", icon: Inbox },
    { view: "overdue", icon: Clock3 },
    { view: "waiting", icon: ArrowUpRight },
    { view: "resolved", icon: Check },
    { view: "settings", icon: SettingsIcon },
  ];
  return (
    <Dialog.Root open={creating} onOpenChange={setCreating}>
      <div className="desk-shell">
        <aside className="sidebar">
          <a className="brand" href="/">
            <span className="brand-mark">
              <Layers3 size={20} />
            </span>
            aidesk
          </a>
          <nav aria-label={t("inbox")}>
            {navigation.map((item) => (
              <button
                key={item.view}
                className={`nav-item ${view === item.view ? "active" : ""}`}
                onClick={() => {
                  setView(item.view);
                }}
              >
                <item.icon size={18} />
                {t(item.view)}
                {item.view === "overdue" && scoped.some(overdue) && (
                  <span className="nav-count">{scoped.filter(overdue).length}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <label className="locale-select">
              {t("language")}
              <select
                value={localePreference ?? "auto"}
                onChange={(event) => {
                  const locale = event.target.value === "auto" ? null : event.target.value;
                  void fetch("/api/v1/me/locale", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ locale }),
                  }).then((response) => {
                    if (response.ok) router.refresh();
                  });
                }}
              >
                <option value="auto">{t("localeAuto")}</option>
                <option value="en">English</option>
                <option value="de">Deutsch</option>
              </select>
            </label>
            <div className="theme-switch" role="group" aria-label={t("theme")}>
              {themes.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-label={t(option.label)}
                  title={t(option.label)}
                  aria-pressed={theme === option.value}
                  onClick={() => {
                    setTheme(option.value);
                    applyTheme(option.value);
                    if (option.value === "system") localStorage.removeItem("aidesk:theme");
                    else localStorage.setItem("aidesk:theme", option.value);
                  }}
                >
                  <option.icon size={15} />
                </button>
              ))}
            </div>
            <div className="operator">
              <span className="avatar">{operator.name.slice(0, 1)}</span>
              <span>{operator.name}</span>
              <button
                className="icon-button"
                aria-label={t("signOut")}
                onClick={() => {
                  void fetch("/api/auth/sign-out", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                  }).then((response) => {
                    if (response.ok) window.location.assign("/login");
                  });
                }}
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </aside>
        <main className="desk-main">
          <header className="topbar">
            <h1>{t(view)}</h1>
            <div className="topbar-actions">
              <div className="project-filter">
                <button
                  className="secondary filter-trigger"
                  aria-expanded={filterOpen}
                  onClick={() => {
                    setFilterOpen(!filterOpen);
                  }}
                >
                  <Layers3 size={16} />
                  {!filters.length
                    ? t("allProjects")
                    : projects
                        .filter((project) => filters.includes(project.id))
                        .map((project) => project.name)
                        .join(", ")}
                  <ChevronDown size={14} />
                </button>
                {filterOpen && (
                  <div className="filter-menu">
                    <button
                      onClick={() => {
                        setFilters([]);
                      }}
                    >
                      <span>{t("allProjects")}</span>
                      {!filters.length && <Check size={14} />}
                    </button>
                    {projects.map((project) => (
                      <label key={project.id}>
                        <input
                          type="checkbox"
                          checked={filters.includes(project.id)}
                          onChange={(event) => {
                            setFilters(
                              event.target.checked
                                ? [...filters, project.id]
                                : filters.filter((id) => id !== project.id),
                            );
                          }}
                        />
                        <i style={{ background: project.color }} />
                        {project.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              {operator.owner && (
                <Dialog.Trigger className="icon-button" aria-label={t("newProject")}>
                  <Plus size={20} />
                </Dialog.Trigger>
              )}
            </div>
          </header>
          {view === "settings" ? (
            <Settings
              viewerId={operator.id}
              owner={operator.owner}
              projects={projects}
              locale={initialLocale}
            />
          ) : view === "overview" ? (
            <section className="overview">
              <h2 className="eyebrow">{t("attention")}</h2>
              <div className="metric-grid">
                <button
                  className="metric warning"
                  onClick={() => {
                    setView("overdue");
                  }}
                >
                  <Clock3 size={20} />
                  <strong>{scoped.filter(overdue).length}</strong>
                  <span>{t("overdue")}</span>
                </button>
                <button
                  className="metric"
                  onClick={() => {
                    setView("inbox");
                  }}
                >
                  <Inbox size={20} />
                  <strong>
                    {
                      scoped.filter(
                        (ticket) =>
                          ticket.status === "open" &&
                          !ticket.assigneeUserId &&
                          !ticket.assigneeAgentId,
                      ).length
                    }
                  </strong>
                  <span>{t("unassigned")}</span>
                </button>
                <button
                  className="metric"
                  onClick={() => {
                    setView("waiting");
                  }}
                >
                  <ArrowUpRight size={20} />
                  <strong>{scoped.filter((ticket) => ticket.status === "waiting").length}</strong>
                  <span>{t("waiting")}</span>
                </button>
              </div>
              <div className="section-heading">
                <h3>{t("waitingSince")}</h3>
                <button
                  className="text-button"
                  onClick={() => {
                    setView("inbox");
                  }}
                >
                  {t("inbox")}
                  <ArrowUpRight size={15} />
                </button>
              </div>
              <div className="overview-tickets">
                {scoped
                  .filter((ticket) => ticket.pendingSince !== null)
                  .slice(0, 8)
                  .map((ticket) => (
                    <button
                      key={ticket.id}
                      className="overview-row"
                      onClick={() => {
                        select(ticket.id);
                      }}
                    >
                      <span className="avatar">{ticket.requesterName.slice(0, 1)}</span>
                      <span className="row-subject">
                        <strong>{ticket.subject}</strong>
                        <small>
                          {ticket.requesterName} · {projectById.get(ticket.projectId)?.name}
                        </small>
                      </span>
                      <span className={`age-badge ${overdue(ticket) ? "urgent" : ""}`}>
                        <Clock3 size={13} />
                        {age(ticket)}
                      </span>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
              </div>
            </section>
          ) : (
            <div className={`inbox-layout ${selected ? "has-selection" : ""}`}>
              <section className="ticket-list" aria-label={t("inbox")}>
                <label className="search-field">
                  <Search size={16} />
                  <input
                    aria-label={t("search")}
                    placeholder={t("search")}
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                    }}
                  />
                </label>
                <div className="list-heading">{t("ticketCount", { count: visible.length })}</div>
                {visible.map((ticket) => (
                  <button
                    key={ticket.id}
                    className={`ticket-row ${selected === ticket.id ? "selected" : ""}`}
                    onClick={() => {
                      select(ticket.id);
                    }}
                  >
                    <span className="ticket-row-top">
                      <strong>{ticket.requesterName}</strong>
                      <span className={overdue(ticket) ? "urgent-text" : "muted"}>
                        {age(ticket)}
                      </span>
                    </span>
                    <span className="ticket-row-subject">{ticket.subject}</span>
                    <span className="ticket-row-meta">
                      <i style={{ background: projectById.get(ticket.projectId)?.color }} />
                      {projectById.get(ticket.projectId)?.name}
                      <span>#{ticket.number}</span>
                    </span>
                  </button>
                ))}
                {visible.length === 0 && (
                  <div className="empty">
                    <Inbox size={24} />
                    <h3>{t("noTickets")}</h3>
                  </div>
                )}
              </section>
              <section className="conversation" aria-label={t("ticket")}>
                {loading ? (
                  <div className="empty">{t("loading")}</div>
                ) : conversation ? (
                  <>
                    <header className="conversation-header">
                      <button
                        className="icon-button mobile-back"
                        aria-label={t("back")}
                        onClick={() => {
                          setSelected(null);
                          window.history.replaceState(null, "", "/");
                        }}
                      >
                        <X size={18} />
                      </button>
                      <div>
                        <div className="eyebrow">
                          {projectById.get(conversation.ticket.projectId)?.name} · #
                          {conversation.ticket.number}
                        </div>
                        <h2>{conversation.ticket.subject}</h2>
                        <p>
                          {conversation.ticket.requesterName} &lt;
                          {conversation.ticket.requesterEmail}&gt;
                        </p>
                      </div>
                      <span className="status-badge">{t(conversation.ticket.status)}</span>
                    </header>
                    <div className="message-list" ref={messageList}>
                      {conversation.messages.map((message) => (
                        <article
                          key={message.id}
                          className={`message ${message.internal ? "internal-message" : ""}`}
                        >
                          <header>
                            <span className="avatar">{message.authorName.slice(0, 1)}</span>
                            <strong>{message.authorName}</strong>
                            {message.internal && (
                              <span className="status-badge">{t("internal")}</span>
                            )}
                            <time dateTime={message.createdAt}>
                              {new Intl.DateTimeFormat(initialLocale, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              }).format(new Date(message.createdAt))}
                            </time>
                          </header>
                          <div
                            className="prose"
                            dangerouslySetInnerHTML={{ __html: message.html }}
                          />
                          {["queued", "sent", "review"].includes(message.deliveryState) && (
                            <small
                              className={
                                message.deliveryState === "review"
                                  ? "delivery-state attention"
                                  : "delivery-state"
                              }
                            >
                              {t(
                                message.deliveryState === "review"
                                  ? (deliveryErrors[message.deliveryError ?? ""] ??
                                      "deliveryFailed")
                                  : message.deliveryState,
                              )}
                            </small>
                          )}
                        </article>
                      ))}
                    </div>
                    {(conversation.actions.includes("ticket.reply") ||
                      conversation.actions.includes("ticket.note")) && (
                      <form
                        className={`composer ${internal ? "private-composer" : ""}`}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void send();
                        }}
                      >
                        <div className="compose-tabs">
                          {conversation.actions.includes("ticket.reply") && (
                            <button
                              type="button"
                              className={!internal ? "active" : ""}
                              onClick={() => {
                                setInternal(false);
                              }}
                            >
                              {t("reply")}
                            </button>
                          )}
                          {conversation.actions.includes("ticket.note") && (
                            <button
                              type="button"
                              className={internal ? "active" : ""}
                              onClick={() => {
                                setInternal(true);
                              }}
                            >
                              {t("note")}
                            </button>
                          )}
                        </div>
                        <textarea
                          aria-label={t(internal ? "composeNote" : "compose")}
                          placeholder={t(internal ? "composeNote" : "compose")}
                          value={draft}
                          onChange={(event) => {
                            editDraft(event.target.value);
                          }}
                          rows={4}
                        />
                        <div className="compose-footer">
                          <small className="compose-identity">
                            {internal ? (
                              t("privateNote")
                            ) : conversation.sender ? (
                              <>
                                <span>
                                  {t("fromSender", { sender: mailbox(conversation.sender) })}
                                </span>
                                <span>
                                  {t("toRecipients", {
                                    recipients: conversation.recipients.map(mailbox).join(", "),
                                  })}
                                </span>
                              </>
                            ) : (
                              t("noOutbound")
                            )}
                            <span>{conversation.ticket.language.toUpperCase()}</span>
                          </small>
                          <button
                            className="primary"
                            disabled={
                              sending ||
                              !draft.trim() ||
                              (!internal && !conversation.sender) ||
                              !conversation.actions.includes(
                                internal ? "ticket.note" : "ticket.reply",
                              )
                            }
                          >
                            <Send size={15} />
                            {t(sending ? "sending" : internal ? "saveNote" : "send")}
                          </button>
                        </div>
                      </form>
                    )}
                  </>
                ) : (
                  <div className="empty">
                    <Layers3 size={32} />
                    <h2>{t("chooseTicket")}</h2>
                  </div>
                )}
                {error && (
                  <p className="error conversation-error" role="alert">
                    {t(error)}
                  </p>
                )}
              </section>
            </div>
          )}
        </main>
        <Dialog.Portal>
          <Dialog.Backdrop className="modal-backdrop" />
          <Dialog.Popup className="modal">
            <button
              className="icon-button modal-close"
              aria-label={t("close")}
              onClick={() => {
                setCreating(false);
              }}
            >
              <X size={18} />
            </button>
            <Dialog.Title render={<h2 />}>{t("newProject")}</Dialog.Title>
            <Dialog.Description className="muted">{t("newProjectDescription")}</Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <label>
                {t("projectName")}
                <input
                  value={projectName}
                  onChange={(event) => {
                    setProjectName(event.target.value);
                  }}
                  required
                  maxLength={100}
                />
              </label>
              <label>
                {t("projectSlug")}
                <input
                  value={slug}
                  onChange={(event) => {
                    setSlug(event.target.value);
                  }}
                  required
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  maxLength={60}
                />
              </label>
              {error && (
                <p className="error" role="alert">
                  {t(error)}
                </p>
              )}
              <div className="modal-actions">
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    setCreating(false);
                  }}
                >
                  {t("cancel")}
                </button>
                <button className="primary" disabled={sending}>
                  {t("create")}
                </button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </div>
    </Dialog.Root>
  );
}
