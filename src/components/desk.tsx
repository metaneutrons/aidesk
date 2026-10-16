"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ArrowUpRight,
  BellRing,
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
  Languages,
  Sparkles,
  Undo2,
  Settings as SettingsIcon,
  ShieldAlert,
  Sun,
  X,
} from "lucide-react";
import { z } from "zod";
import { Dialog } from "@base-ui/react/dialog";
import { OriginalPreview } from "./original-preview";
import { PortalLink } from "./portal-link";
import { Reminder } from "./reminder";
import { listCeiling, listStep } from "../domain/paging";
import { responseState } from "../domain/response-clock";
import type { Locale } from "../domain/locale";
import { actions } from "../domain/permissions";
import { Assignment } from "./assignment";
import { Issues } from "./issues";
import { Knowledge } from "./knowledge";
import { Translations } from "./translations";
import { aiWorkStates, stopLevels } from "../domain/agent-work";
import { Settings } from "./settings";
import { Junk } from "./junk";
import { Tags } from "./tags";
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
  remindAt: z.string().nullable(),
  tags: z.array(z.string()),
  junkAt: z.string().nullable(),
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
  links: z.array(
    z.object({
      text: z.string(),
      url: z.string(),
      host: z.string().nullable(),
      misleading: z.boolean(),
    }),
  ),
  deliveryState: z.string(),
  deliveryError: z.string().nullable(),
  hasOriginal: z.boolean(),
  language: z.string(),
  extractionUncertain: z.boolean(),
  extraction: z.enum(["parser", "ai"]),
  extractionFailure: z.string().nullable(),
  parserMarkdown: z.string().nullable(),
  junkCheck: z.enum(["clean", "uncertain", "failed"]).nullable(),
  attachments: z.array(
    z.object({
      id: z.uuid(),
      filename: z.string(),
      size: z.number(),
      refusal: z.string().nullable(),
    }),
  ),
  createdAt: z.string(),
});
// Why a reply needs checking. Codes without their own text keep the general
// one; each text says whether the mail was sent.
const searchHitSchema = z.object({
  id: z.string(),
  number: z.number(),
  projectId: z.string(),
  subject: z.string(),
  status: z.string(),
  requesterName: z.string(),
  snippet: z.string().nullable(),
});
type SearchHit = z.infer<typeof searchHitSchema>;
// What a failed draft says, by the code of the answer.
const assistErrors: Record<
  string,
  | "assistNotConfigured"
  | "assistBudget"
  | "assistTimeout"
  | "assistQuota"
  | "assistModel"
  | "assistRateLimited"
  | "assistFailed"
  | "translateUnusable"
  | "translateSame"
> = {
  ai_not_configured: "assistNotConfigured",
  ai_disabled: "assistNotConfigured",
  ai_budget_exceeded: "assistBudget",
  ai_timeout: "assistTimeout",
  ai_quota_exhausted: "assistQuota",
  ai_model_unavailable: "assistModel",
  ai_rate_limited: "assistRateLimited",
  ai_provider_error: "assistFailed",
  translation_unusable: "translateUnusable",
  conflict: "translateSame",
};
// The messages that name how long to wait, for the failures that can come with a wait.
const assistWaits: Record<string, "assistRateLimitedWait" | "assistQuotaWait"> = {
  assistRateLimited: "assistRateLimitedWait",
  assistQuota: "assistQuotaWait",
};
function waitText(seconds: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  if (seconds < 3600) return format.format(Math.max(1, Math.ceil(seconds / 60)), "minute");
  if (seconds < 2 * 86_400) return format.format(Math.ceil(seconds / 3600), "hour");
  return format.format(Math.ceil(seconds / 86_400), "day");
}
const deliveryErrors: Record<string, string> = {
  recipient_suppressed: "deliveryRecipientSuppressed",
  suppression_check_failed: "deliverySuppressionCheckFailed",
  transport_rejected: "deliveryRejected",
  recipient_not_accepted: "deliveryRejected",
  transport_acceptance_unknown: "deliveryUnknown",
  expired_dispatch_lease: "deliveryUnknown",
  bounced: "deliveryBounced",
  stale_or_paused_dispatch: "deliveryStale",
  dispatch_grant_revoked: "deliveryNotAllowed",
  acknowledgement_not_enabled: "deliveryNotAllowed",
  autonomous_dispatch_not_enabled: "deliveryNotAllowed",
  outbound_not_ready: "deliveryConnection",
  development_connection_not_allowed: "deliveryConnection",
  smtp_tls_required: "deliveryConnection",
};
// Bytes below 1 KB, otherwise kB or MB with at most one decimal.
function formatSize(size: number, locale: string): string {
  const [value, unit] =
    size < 1024
      ? [size, "byte"]
      : size < 1_048_576
        ? [size / 1024, "kilobyte"]
        : [size / 1_048_576, "megabyte"];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value);
}
const refusals: Record<string, string> = {
  attachment_type_blocked: "attachmentTypeBlocked",
  attachment_too_large: "attachmentTooLarge",
  attachment_count_exceeded: "attachmentCountExceeded",
};
const addressSchema = z.object({ name: z.string(), address: z.string() });
const conversationSchema = z.object({
  ticket: ticketSchema,
  assignee: z
    .object({
      kind: z.enum(["user", "agent"]),
      id: z.string(),
      name: z.string(),
      managed: z.boolean(),
    })
    .nullable(),
  aiWork: z
    .object({
      state: z.enum(aiWorkStates),
      reason: z.string().nullable(),
      stoppedBy: z.enum(stopLevels).nullable(),
    })
    .nullable(),
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
  // After how many hours without an answer a ticket of the project is overdue.
  overdueHours: number;
}
interface Overview {
  projects: {
    projectId: string;
    total: number;
    overdue: number;
    unassigned: number;
    remindersDue: number;
    waiting: number;
  }[];
  oldest: Ticket[];
}
interface Props {
  projects: Project[];
  initialTickets: Ticket[];
  overview: Overview;
  listLimit: number;
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
type View =
  "overview" | "inbox" | "overdue" | "reminders" | "waiting" | "resolved" | "junk" | "settings";
export function Desk({
  projects,
  initialTickets,
  overview,
  listLimit,
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
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // The server's answer for a text of two or more characters; it covers all
  // tickets of the authorized projects, not only the loaded list.
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [selected, setSelected] = useState(initialTicketId);
  const [conversation, setConversation] = useState<z.infer<typeof conversationSchema> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How long the provider asked to wait, for the message of the key that came with it.
  const [errorWait, setErrorWait] = useState<{ key: string; seconds: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [internal, setInternal] = useState(false);
  const [sending, setSending] = useState(false);
  // A draft that a model wrote: running, the instruction for the next one, what the
  // field held before (to undo it) and what to tell the person about it.
  const [assisting, setAssisting] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [undo, setUndo] = useState<string | null>(null);
  const [assistNote, setAssistNote] = useState<
    "assistDone" | "assistTruncated" | "translateDone" | null
  >(null);
  const [translating, setTranslating] = useState(false);
  const [useKnowledge, setUseKnowledge] = useState(false);
  const [assistSources, setAssistSources] = useState(0);
  const [theme, setTheme] = useState<Theme>("system");
  const [now, setNow] = useState(serverTime);
  const [creating, setCreating] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [slug, setSlug] = useState("");
  const messageList = useRef<HTMLDivElement>(null);
  // Where the person is now, so that a draft that arrives after they moved on is dropped.
  const place = useRef({ selected: initialTicketId, internal: false });
  place.current = { selected, internal };
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
    setUndo(null);
    setAssistNote(null);
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
  // The AI work on a ticket goes on in the worker as well: follow it until it ends.
  const aiWorking =
    conversation?.aiWork?.state === "queued" || conversation?.aiWork?.state === "running";
  useEffect(() => {
    if (!selected || !aiWorking) return;
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
          if (next.aiWork?.state === "queued" || next.aiWork?.state === "running") return;
          window.clearInterval(timer);
          setConversation(next);
          transition(() => {
            router.refresh();
          });
        })
        .catch(() => undefined);
    }, 3_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [selected, aiWorking, router]);
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
  const searching = search.trim().length >= 2;
  useEffect(() => {
    if (!searching) {
      setHits(null);
      return;
    }
    const request = { current: true };
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ q: search.trim() });
      for (const project of filters) query.append("project", project);
      void (async () => {
        const response = await fetch(`/api/v1/tickets/search?${query.toString()}`).catch(
          () => null,
        );
        const parsed = response?.ok
          ? z.array(searchHitSchema).safeParse(await response.json())
          : null;
        if (request.current && parsed?.success) setHits(parsed.data);
      })();
    }, 250);
    return () => {
      request.current = false;
      window.clearTimeout(timer);
    };
  }, [search, searching, filters]);
  const scoped = initialTickets.filter(
    (ticket) =>
      (!filters.length || filters.includes(ticket.projectId)) &&
      (tagFilter === null || ticket.tags.includes(tagFilter)) &&
      (searching ||
        `${ticket.subject} ${ticket.requesterName} ${ticket.requesterEmail}`
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  const overdue = (ticket: Ticket) =>
    ticket.pendingSince !== null &&
    responseState(
      { receivedAt: new Date(ticket.pendingSince), answeredAt: null },
      new Date(now),
      undefined,
      projectById.get(ticket.projectId)?.overdueHours,
    ) === "overdue";
  // The list is refreshed after a change, so it is the newer source; a cleared
  // reminder is null there and must not fall back to the older conversation.
  const reminderOf = (ticket: { id: string; remindAt: string | null }) => {
    const entry = initialTickets.find((candidate) => candidate.id === ticket.id);
    return entry ? entry.remindAt : ticket.remindAt;
  };
  const tagsOf = (ticket: { id: string; tags: string[] }) =>
    initialTickets.find((candidate) => candidate.id === ticket.id)?.tags ?? ticket.tags;
  // Tags of the tickets in the chosen projects, most used first, for the filter.
  const tagCounts = [
    ...initialTickets
      .filter((ticket) => !filters.length || filters.includes(ticket.projectId))
      .flatMap((ticket) => ticket.tags)
      .reduce(
        (counts, tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1),
        new Map<string, number>(),
      ),
  ].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // Numbers over every ticket of the chosen projects, counted by the server,
  // and the oldest unanswered ones of those projects.
  const chosen = overview.projects.filter(
    (entry) => !filters.length || filters.includes(entry.projectId),
  );
  const sum = (key: "total" | "overdue" | "unassigned" | "remindersDue" | "waiting") =>
    chosen.reduce((total, entry) => total + entry[key], 0);
  const oldest = overview.oldest
    .filter((ticket) => !filters.length || filters.includes(ticket.projectId))
    .sort(
      (a, b) => new Date(a.pendingSince ?? 0).getTime() - new Date(b.pendingSince ?? 0).getTime(),
    )
    .slice(0, 8);
  const loaded = initialTickets.filter(
    (ticket) => !filters.length || filters.includes(ticket.projectId),
  ).length;
  function loadMore() {
    transition(() => {
      router.replace(`/?limit=${String(listLimit + listStep)}`, { scroll: false });
    });
  }
  const reminderDue = (ticket: Ticket) =>
    ticket.remindAt !== null && new Date(ticket.remindAt).getTime() <= now;
  const visible = scoped
    .filter((ticket) => view !== "reminders" || ticket.remindAt !== null)
    .sort((a, b) =>
      view === "reminders"
        ? new Date(a.remindAt ?? 0).getTime() - new Date(b.remindAt ?? 0).getTime()
        : 0,
    )
    .filter((ticket) =>
      view === "overdue"
        ? overdue(ticket)
        : view === "reminders"
          ? true
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
  async function moveToJunk(): Promise<void> {
    if (!selected) return;
    setError(null);
    const response = await fetch(`/api/v1/tickets/${selected}/junk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    if (!response?.ok) {
      setError("error");
      return;
    }
    setSelected(null);
    setConversation(null);
    window.history.replaceState(null, "", "/");
    transition(() => {
      router.refresh();
    });
  }
  // A person sends or discards the draft an agent wrote under the review policy.
  async function draftAction(messageId: string, action: "send" | "discard"): Promise<void> {
    setError(null);
    const response = await fetch(`/api/v1/messages/${messageId}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    if (!response?.ok) setError(response?.status === 409 ? "draftStale" : "error");
    if (selected) {
      const next = await fetch(`/api/v1/tickets/${selected}`).catch(() => null);
      if (next?.ok) setConversation(conversationSchema.parse(await next.json()));
    }
    transition(() => {
      router.refresh();
    });
  }
  // A first version of the reply or the note, from the AI task of the project. It
  // replaces the field as text to edit, keeps what was there for an undo, and is not
  // sent.
  async function assist(): Promise<void> {
    if (!conversation || !selected) return;
    const asked = { selected, internal };
    const before = draft;
    setAssisting(true);
    setError(null);
    setUndo(null);
    setAssistNote(null);
    try {
      const response = await fetch(`/api/v1/tickets/${selected}/draft-assist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: internal ? "note" : "reply",
          ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
          ...(draft.trim() ? { current: draft.slice(0, 8000) } : {}),
          ...(useKnowledge ? { knowledge: true } : {}),
        }),
      });
      if (!response.ok) {
        const code = z
          .object({ error: z.string() })
          .safeParse(await response.json().catch(() => null));
        const key = (code.success ? assistErrors[code.data.error] : undefined) ?? "assistFailed";
        const seconds = Number(response.headers.get("retry-after"));
        setErrorWait(Number.isFinite(seconds) && seconds > 0 ? { key, seconds } : null);
        setError(key);
        return;
      }
      const result = z
        .object({
          text: z.string(),
          truncated: z.boolean(),
          knowledgePassages: z.number().default(0),
        })
        .parse(await response.json());
      if (place.current.selected !== asked.selected || place.current.internal !== asked.internal)
        return;
      setUndo(before);
      editDraft(result.text);
      setAssistSources(result.knowledgePassages);
      setAssistNote(result.truncated ? "assistTruncated" : "assistDone");
    } catch {
      setError("assistFailed");
    } finally {
      setAssisting(false);
    }
  }
  // The text in the field in the language of the customer, to read and edit; nothing is sent.
  async function translateDraft(): Promise<void> {
    if (!conversation || !selected || !draft.trim()) return;
    const asked = { selected, internal };
    const before = draft;
    setTranslating(true);
    setError(null);
    setUndo(null);
    setAssistNote(null);
    try {
      const response = await fetch(`/api/v1/tickets/${selected}/translate-draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          markdown: draft.slice(0, 20_000),
          language: conversation.ticket.language,
        }),
      });
      if (!response.ok) {
        const code = z
          .object({ error: z.string() })
          .safeParse(await response.json().catch(() => null));
        const key = (code.success ? assistErrors[code.data.error] : undefined) ?? "assistFailed";
        const seconds = Number(response.headers.get("retry-after"));
        setErrorWait(Number.isFinite(seconds) && seconds > 0 ? { key, seconds } : null);
        setError(key);
        return;
      }
      const result = z.object({ text: z.string() }).parse(await response.json());
      if (place.current.selected !== asked.selected || place.current.internal !== asked.internal)
        return;
      setUndo(before);
      editDraft(result.text);
      setAssistNote("translateDone");
    } catch {
      setError("assistFailed");
    } finally {
      setTranslating(false);
    }
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
      setUndo(null);
      setAssistNote(null);
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
    { view: "reminders", icon: BellRing },
    { view: "waiting", icon: ArrowUpRight },
    { view: "resolved", icon: Check },
    { view: "junk", icon: ShieldAlert },
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
                {item.view === "overdue" && sum("overdue") > 0 && (
                  <span className="nav-count">{sum("overdue")}</span>
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
          {view === "junk" ? (
            <Junk
              projects={projects}
              locale={initialLocale}
              onRestored={() => {
                transition(() => {
                  router.refresh();
                });
              }}
            />
          ) : view === "settings" ? (
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
                  <strong>{sum("overdue")}</strong>
                  <span>{t("overdue")}</span>
                </button>
                <button
                  className="metric"
                  onClick={() => {
                    setView("inbox");
                  }}
                >
                  <Inbox size={20} />
                  <strong>{sum("unassigned")}</strong>
                  <span>{t("unassigned")}</span>
                </button>
                <button
                  className="metric warning"
                  onClick={() => {
                    setView("reminders");
                  }}
                >
                  <BellRing size={20} />
                  <strong>{sum("remindersDue")}</strong>
                  <span>{t("remindersDue")}</span>
                </button>
                <button
                  className="metric"
                  onClick={() => {
                    setView("waiting");
                  }}
                >
                  <ArrowUpRight size={20} />
                  <strong>{sum("waiting")}</strong>
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
                {oldest.map((ticket) => (
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
                {tagCounts.length > 0 && (
                  <div className="tag-filter" role="group" aria-label={t("tagFilter")}>
                    <button
                      type="button"
                      className={`tag-chip ${tagFilter === null ? "active" : ""}`}
                      aria-pressed={tagFilter === null}
                      onClick={() => {
                        setTagFilter(null);
                      }}
                    >
                      {t("tagFilterClear")}
                    </button>
                    {tagCounts.slice(0, 20).map(([tag, count]) => (
                      <button
                        key={tag}
                        type="button"
                        className={`tag-chip ${tagFilter === tag ? "active" : ""}`}
                        aria-pressed={tagFilter === tag}
                        onClick={() => {
                          setTagFilter(tagFilter === tag ? null : tag);
                        }}
                      >
                        {tag} <span className="muted">{count}</span>
                      </button>
                    ))}
                  </div>
                )}
                {searching && hits !== null ? (
                  <>
                    <div className="list-heading" role="status">
                      {t("searchResults", { count: hits.length })}
                    </div>
                    {hits.map((hit) => (
                      <button
                        key={hit.id}
                        className={`ticket-row ${selected === hit.id ? "selected" : ""}`}
                        onClick={() => {
                          select(hit.id);
                        }}
                      >
                        <span className="ticket-row-top">
                          <strong>{hit.requesterName}</strong>
                          <span className="muted">{t(hit.status)}</span>
                        </span>
                        <span className="ticket-row-subject">{hit.subject}</span>
                        {hit.snippet && <span className="ticket-row-snippet">{hit.snippet}</span>}
                        <span className="ticket-row-meta">
                          <i style={{ background: projectById.get(hit.projectId)?.color }} />
                          {projectById.get(hit.projectId)?.name}
                          <span>#{hit.number}</span>
                        </span>
                      </button>
                    ))}
                    {hits.length === 0 && (
                      <div className="empty">
                        <Search size={24} />
                        <h3>{t("noSearchResults")}</h3>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="list-heading">
                      {t("ticketCount", { count: visible.length })}
                    </div>
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
                        {ticket.remindAt && (
                          <span className={reminderDue(ticket) ? "urgent-text" : "muted"}>
                            {t(reminderDue(ticket) ? "reminderDueShort" : "reminderSetShort", {
                              date: new Intl.DateTimeFormat(initialLocale, {
                                dateStyle: "medium",
                                timeStyle: "short",
                              }).format(new Date(ticket.remindAt)),
                            })}
                          </span>
                        )}
                        {ticket.tags.length > 0 && (
                          <span className="ticket-row-tags">
                            {ticket.tags.map((tag) => (
                              <span key={tag} className="tag-chip">
                                {tag}
                              </span>
                            ))}
                          </span>
                        )}
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
                    {loaded < sum("total") && (
                      <div className="list-more">
                        <span className="muted">
                          {t("ticketsLoaded", { loaded, total: sum("total") })}
                        </span>
                        {listLimit < listCeiling && (
                          <button type="button" className="secondary" onClick={loadMore}>
                            {t("showMore")}
                          </button>
                        )}
                      </div>
                    )}
                  </>
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
                      <span className="status-badge">
                        {t(conversation.ticket.junkAt ? "junk" : conversation.ticket.status)}
                      </span>
                      <div className="ticket-tools">
                        {!conversation.ticket.junkAt && (
                          <details className="ticket-knowledge">
                            <summary>{t("knowledgeToggle")}</summary>
                            <Knowledge
                              key={conversation.ticket.id}
                              ticketId={conversation.ticket.id}
                              locale={initialLocale}
                            />
                          </details>
                        )}
                        {!conversation.ticket.junkAt && (
                          <Issues
                            key={`${conversation.ticket.id}:issues`}
                            ticketId={conversation.ticket.id}
                            canNote={conversation.actions.includes("ticket.note")}
                            canPublish={conversation.actions.includes("github.publish")}
                          />
                        )}
                        {!conversation.ticket.junkAt && (
                          <Assignment
                            key={`${conversation.ticket.id}:${String(conversation.ticket.revision)}:${conversation.aiWork?.state ?? ""}:${conversation.assignee?.id ?? ""}`}
                            ticketId={conversation.ticket.id}
                            revision={conversation.ticket.revision}
                            assignee={conversation.assignee}
                            aiWork={conversation.aiWork}
                            canAssign={conversation.actions.includes("ticket.assign")}
                            onChanged={() => {
                              void fetch(`/api/v1/tickets/${conversation.ticket.id}`)
                                .then(async (response) => {
                                  if (response.ok)
                                    setConversation(
                                      conversationSchema.parse(await response.json()),
                                    );
                                })
                                .catch(() => undefined);
                              transition(() => {
                                router.refresh();
                              });
                            }}
                          />
                        )}
                        {conversation.actions.includes("ticket.reply") &&
                          !conversation.ticket.junkAt && (
                            <PortalLink
                              key={`${conversation.ticket.id}:portal`}
                              ticketId={conversation.ticket.id}
                              locale={initialLocale}
                            />
                          )}
                        {conversation.actions.includes("ticket.note") &&
                          !conversation.ticket.junkAt && (
                            <Tags
                              key={`${conversation.ticket.id}:tags`}
                              ticketId={conversation.ticket.id}
                              projectId={conversation.ticket.projectId}
                              tags={tagsOf(conversation.ticket)}
                              onChanged={() => {
                                transition(() => {
                                  router.refresh();
                                });
                              }}
                            />
                          )}
                        {conversation.actions.includes("ticket.note") &&
                          !conversation.ticket.junkAt && (
                            <Reminder
                              key={`${conversation.ticket.id}:${reminderOf(conversation.ticket) ?? ""}`}
                              ticketId={conversation.ticket.id}
                              remindAt={reminderOf(conversation.ticket)}
                              now={now}
                              locale={initialLocale}
                              onChanged={() => {
                                transition(() => {
                                  router.refresh();
                                });
                              }}
                            />
                          )}
                        {conversation.actions.includes("ticket.junk") &&
                          !conversation.ticket.junkAt && (
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                void moveToJunk();
                              }}
                            >
                              {t("moveToJunk")}
                            </button>
                          )}
                      </div>
                    </header>
                    <div
                      className="message-list"
                      ref={messageList}
                      role="region"
                      aria-label={t("messages")}
                      tabIndex={0}
                    >
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
                            {message.authorType === "system" && (
                              <span className="status-badge">{t("acknowledgement")}</span>
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
                          {message.authorType !== "system" && (
                            <details className="message-translate">
                              <summary>{t("translationsToggle")}</summary>
                              <Translations
                                messageId={message.id}
                                messageLanguage={message.language}
                                canRemove={conversation.actions.includes("ticket.reply")}
                                locale={initialLocale}
                              />
                            </details>
                          )}
                          {message.authorType === "customer" &&
                            (message.extraction === "ai" ||
                              message.extractionFailure !== null ||
                              message.junkCheck === "uncertain" ||
                              message.junkCheck === "failed") && (
                              <div className="message-checks">
                                {message.extraction === "ai" && (
                                  <details>
                                    <summary className="muted">{t("extractionAi")}</summary>
                                    <pre className="parser-text">{message.parserMarkdown}</pre>
                                  </details>
                                )}
                                {message.extractionFailure !== null && (
                                  <small className="attention">
                                    {t("extractionFailed", { code: message.extractionFailure })}
                                  </small>
                                )}
                                {(message.junkCheck === "uncertain" ||
                                  message.junkCheck === "failed") && (
                                  <small className="attention">
                                    {t(
                                      message.junkCheck === "uncertain"
                                        ? "junkCheckUncertain"
                                        : "junkCheckFailed",
                                    )}
                                  </small>
                                )}
                              </div>
                            )}
                          {message.authorType === "customer" && message.hasOriginal && (
                            <p className="message-original">
                              {message.extractionUncertain && (
                                <span className="attention">{t("extractionUncertain")}</span>
                              )}
                              <OriginalPreview messageId={message.id} locale={initialLocale} />
                              <a href={`/api/v1/messages/${message.id}/original`} download>
                                {t("originalMail")}
                              </a>
                            </p>
                          )}
                          {message.attachments.length > 0 && (
                            <ul className="attachments" aria-label={t("attachments")}>
                              {message.attachments.map((file) => (
                                <li key={file.id}>
                                  {file.refusal ? (
                                    <span className="refused">
                                      {file.filename}:{" "}
                                      {t(refusals[file.refusal] ?? "attachmentRefused")}
                                    </span>
                                  ) : (
                                    <a href={`/api/v1/attachments/${file.id}`} download>
                                      {file.filename}
                                    </a>
                                  )}
                                  <small>{formatSize(file.size, initialLocale)}</small>
                                </li>
                              ))}
                            </ul>
                          )}
                          {message.deliveryState === "draft" && (
                            <div className="draft-note">
                              <small className="delivery-state attention">
                                {t("draftNotSent")}
                              </small>
                              {message.links.length > 0 && (
                                <div className="draft-links">
                                  <strong>{t("draftLinks")}</strong>
                                  <ul>
                                    {message.links.map((link) => (
                                      <li key={`${link.text}\n${link.url}`}>
                                        <span>{link.text || link.url}</span>
                                        {" → "}
                                        <code>{link.url}</code>
                                        {link.misleading && (
                                          <span className="attention">
                                            {" "}
                                            {t("draftLinkMisleading")}
                                          </span>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {conversation.actions.includes("ticket.reply") && (
                                <span className="configuration-actions">
                                  <button
                                    type="button"
                                    className="primary"
                                    onClick={() => {
                                      void draftAction(message.id, "send");
                                    }}
                                  >
                                    {t("draftSend")}
                                  </button>
                                  <button
                                    type="button"
                                    className="secondary"
                                    onClick={() => {
                                      void draftAction(message.id, "discard");
                                    }}
                                  >
                                    {t("draftDiscard")}
                                  </button>
                                </span>
                              )}
                            </div>
                          )}
                          {message.deliveryState === "discarded" && (
                            <small className="delivery-state">{t("draftDiscarded")}</small>
                          )}
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
                                setUndo(null);
                                setAssistNote(null);
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
                                setUndo(null);
                                setAssistNote(null);
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
                          readOnly={assisting || translating}
                        />
                        <div className="assist-row">
                          <input
                            type="text"
                            aria-label={t("assistInstruction")}
                            placeholder={t("assistInstruction")}
                            maxLength={1000}
                            value={instruction}
                            onChange={(event) => {
                              setInstruction(event.target.value);
                            }}
                          />
                          <button
                            type="button"
                            disabled={
                              assisting ||
                              sending ||
                              !conversation.actions.includes(
                                internal ? "ticket.note" : "ticket.reply",
                              )
                            }
                            onClick={() => {
                              void assist();
                            }}
                          >
                            <Sparkles size={14} />
                            {t(assisting ? "assistWorking" : "assistButton")}
                          </button>
                          <button
                            type="button"
                            disabled={
                              translating ||
                              assisting ||
                              sending ||
                              !draft.trim() ||
                              !conversation.actions.includes(
                                internal ? "ticket.note" : "ticket.reply",
                              )
                            }
                            onClick={() => {
                              void translateDraft();
                            }}
                          >
                            <Languages size={14} />
                            {translating
                              ? t("translateDraftWorking")
                              : t("translateDraftButton", {
                                  language:
                                    new Intl.DisplayNames(initialLocale, { type: "language" }).of(
                                      conversation.ticket.language,
                                    ) ?? conversation.ticket.language,
                                })}
                          </button>
                          <label className="assist-knowledge">
                            <input
                              type="checkbox"
                              checked={useKnowledge}
                              onChange={(event) => {
                                setUseKnowledge(event.target.checked);
                              }}
                            />
                            {t("assistKnowledge")}
                          </label>
                          {undo !== null && (
                            <button
                              type="button"
                              onClick={() => {
                                editDraft(undo);
                                setUndo(null);
                                setAssistNote(null);
                              }}
                            >
                              <Undo2 size={14} />
                              {t("assistUndo")}
                            </button>
                          )}
                        </div>
                        {assistNote && (
                          <p className="assist-note" role="status">
                            {t(assistNote)}
                            {assistNote !== "translateDone" && assistSources > 0
                              ? ` ${t("assistSources", { count: assistSources })}`
                              : ""}
                          </p>
                        )}
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
                    {errorWait?.key === error && error in assistWaits
                      ? t(assistWaits[error] ?? "assistFailed", {
                          when: waitText(errorWait.seconds, initialLocale),
                        })
                      : t(error)}
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
